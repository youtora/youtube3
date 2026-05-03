-- תיקון מכאן ולהבא בלבד לתגיות/האשטגים.
-- לא מוחק ולא בונה מחדש נתונים ישנים.

CREATE TABLE IF NOT EXISTS tag_stats (
  tag_type TEXT NOT NULL,
  language_code TEXT NOT NULL,
  tag_norm TEXT NOT NULL,
  tag_value TEXT NOT NULL DEFAULT '',
  video_count INTEGER NOT NULL DEFAULT 0,
  latest_published_at INTEGER,
  updated_at INTEGER,
  PRIMARY KEY (tag_type, language_code, tag_norm)
);

CREATE INDEX IF NOT EXISTS idx_tag_stats_list
  ON tag_stats(tag_type, language_code, video_count DESC, latest_published_at DESC, tag_norm);

CREATE INDEX IF NOT EXISTS idx_video_tags_lookup
  ON video_tags(tag_type, tag_norm, video_rowid DESC);

CREATE INDEX IF NOT EXISTS idx_video_tags_video_id
  ON video_tags(video_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_video_tags_unique
  ON video_tags(video_id, tag_type, tag_norm);

DROP TRIGGER IF EXISTS trg_video_tags_ai_tag_stats;
DROP TRIGGER IF EXISTS trg_video_tags_ad_tag_stats;
DROP TRIGGER IF EXISTS trg_videos_au_tag_stats;

CREATE TRIGGER trg_video_tags_ai_tag_stats
AFTER INSERT ON video_tags
BEGIN
  INSERT INTO tag_stats(
    tag_type,
    language_code,
    tag_norm,
    tag_value,
    video_count,
    latest_published_at,
    updated_at
  )
  SELECT
    NEW.tag_type,
    v.language_code,
    NEW.tag_norm,
    NEW.tag_value,
    1,
    COALESCE(v.published_at, 0),
    CAST(strftime('%s', 'now') AS INTEGER)
  FROM videos AS v
  WHERE v.id = NEW.video_rowid
    AND v.netfree_status = 1
    AND COALESCE(v.language_code, '') <> ''
  ON CONFLICT(tag_type, language_code, tag_norm) DO UPDATE SET
    tag_value = CASE
      WHEN COALESCE(tag_stats.tag_value, '') = '' THEN excluded.tag_value
      ELSE tag_stats.tag_value
    END,
    video_count = tag_stats.video_count + 1,
    latest_published_at = MAX(
      COALESCE(tag_stats.latest_published_at, 0),
      COALESCE(excluded.latest_published_at, 0)
    ),
    updated_at = excluded.updated_at;
END;

CREATE TRIGGER trg_video_tags_ad_tag_stats
AFTER DELETE ON video_tags
BEGIN
  UPDATE tag_stats
  SET
    video_count = CASE
      WHEN video_count > 0 THEN video_count - 1
      ELSE 0
    END,
    latest_published_at = CASE
      WHEN COALESCE(latest_published_at, 0) = COALESCE((
        SELECT v0.published_at
        FROM videos AS v0
        WHERE v0.id = OLD.video_rowid
      ), 0)
      THEN COALESCE((
        SELECT MAX(v1.published_at)
        FROM video_tags AS t1
        JOIN videos AS v1
          ON v1.id = t1.video_rowid
        WHERE t1.tag_type = OLD.tag_type
          AND t1.tag_norm = OLD.tag_norm
          AND v1.netfree_status = 1
          AND v1.language_code = COALESCE((
            SELECT v2.language_code
            FROM videos AS v2
            WHERE v2.id = OLD.video_rowid
          ), '')
      ), 0)
      ELSE latest_published_at
    END,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER)
  WHERE tag_type = OLD.tag_type
    AND tag_norm = OLD.tag_norm
    AND language_code = COALESCE((
      SELECT v3.language_code
      FROM videos AS v3
      WHERE v3.id = OLD.video_rowid
    ), '')
    AND EXISTS (
      SELECT 1
      FROM videos AS v4
      WHERE v4.id = OLD.video_rowid
        AND v4.netfree_status = 1
        AND COALESCE(v4.language_code, '') <> ''
    );

  DELETE FROM tag_stats
  WHERE video_count <= 0;
END;

CREATE TRIGGER trg_videos_au_tag_stats
AFTER UPDATE OF netfree_status, language_code, published_at ON videos
WHEN COALESCE(OLD.netfree_status, -1) <> COALESCE(NEW.netfree_status, -1)
  OR COALESCE(OLD.language_code, '') <> COALESCE(NEW.language_code, '')
  OR COALESCE(OLD.published_at, 0) <> COALESCE(NEW.published_at, 0)
BEGIN
  DELETE FROM tag_stats
  WHERE language_code IN (COALESCE(OLD.language_code, ''), COALESCE(NEW.language_code, ''))
    AND EXISTS (
      SELECT 1
      FROM video_tags AS own
      WHERE own.video_rowid = NEW.id
        AND own.tag_type = tag_stats.tag_type
        AND own.tag_norm = tag_stats.tag_norm
    );

  INSERT INTO tag_stats(
    tag_type,
    language_code,
    tag_norm,
    tag_value,
    video_count,
    latest_published_at,
    updated_at
  )
  SELECT
    t.tag_type,
    v.language_code,
    t.tag_norm,
    MIN(t.tag_value) AS tag_value,
    COUNT(*) AS video_count,
    MAX(v.published_at) AS latest_published_at,
    CAST(strftime('%s', 'now') AS INTEGER) AS updated_at
  FROM video_tags AS t
  JOIN videos AS v
    ON v.id = t.video_rowid
  WHERE v.netfree_status = 1
    AND COALESCE(v.language_code, '') <> ''
    AND v.language_code IN (COALESCE(OLD.language_code, ''), COALESCE(NEW.language_code, ''))
    AND EXISTS (
      SELECT 1
      FROM video_tags AS own
      WHERE own.video_rowid = NEW.id
        AND own.tag_type = t.tag_type
        AND own.tag_norm = t.tag_norm
    )
  GROUP BY
    t.tag_type,
    v.language_code,
    t.tag_norm;
END;
