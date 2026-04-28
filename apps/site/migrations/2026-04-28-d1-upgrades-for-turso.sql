-- Turso schema sync from the latest D1 project.
-- Safe for a fresh Turso DB. For an already-upgraded DB, run ALTER TABLE lines only if the columns do not exist.

ALTER TABLE videos ADD COLUMN view_count INTEGER;
ALTER TABLE videos ADD COLUMN like_count INTEGER;
ALTER TABLE videos ADD COLUMN comment_count INTEGER;
ALTER TABLE videos ADD COLUMN stats_fetched_at INTEGER;

CREATE TABLE IF NOT EXISTS video_details (
  video_id TEXT PRIMARY KEY,
  description TEXT DEFAULT '',
  tags_json TEXT DEFAULT '[]',
  hashtags_json TEXT DEFAULT '[]',
  category_id TEXT DEFAULT '',
  default_language TEXT DEFAULT '',
  default_audio_language TEXT DEFAULT '',
  live_broadcast_content TEXT DEFAULT '',
  fetched_at INTEGER,
  updated_at INTEGER
);

CREATE VIRTUAL TABLE IF NOT EXISTS video_details_fts
USING fts5(
  description,
  tags,
  hashtags,
  video_id UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS video_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL,
  video_rowid INTEGER NOT NULL,
  tag_type TEXT NOT NULL,
  tag_value TEXT NOT NULL,
  tag_norm TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_video_details_fetched
  ON video_details(fetched_at);

CREATE INDEX IF NOT EXISTS idx_video_tags_lookup
  ON video_tags(tag_type, tag_norm, video_rowid DESC);

CREATE INDEX IF NOT EXISTS idx_video_tags_video_id
  ON video_tags(video_id);

CREATE UNIQUE INDEX IF NOT EXISTS ux_video_tags_unique
  ON video_tags(video_id, tag_type, tag_norm);

CREATE INDEX IF NOT EXISTS idx_videos_stats_fetched
  ON videos(stats_fetched_at, id);
