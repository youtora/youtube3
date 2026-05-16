-- Etrog / NetFree channel policy support.
-- Run once before deploying code that reads these columns.
-- policy values:
-- 1 = open in NetFree and Etrog
-- 2 = NetFree checked, Etrog open
-- 3 = NetFree checked, Etrog blocks what NetFree blocked
-- 4 = sensitive: Etrog shows only what NetFree opened

ALTER TABLE channels ADD COLUMN filter_policy INTEGER NOT NULL DEFAULT 3;
ALTER TABLE videos ADD COLUMN etrog_visible INTEGER NOT NULL DEFAULT 0;

UPDATE channels
SET filter_policy = CASE
  WHEN COALESCE(netfree_default_status, 0) = 1 THEN 1
  ELSE 3
END
WHERE filter_policy IS NULL
   OR filter_policy NOT IN (1, 2, 3, 4);

UPDATE videos
SET etrog_visible = CASE
  WHEN COALESCE(netfree_status, 0) = 4 THEN 0
  WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 1 THEN 1
  WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 2 THEN 1
  WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 3
       AND COALESCE(netfree_status, 0) <> 2 THEN 1
  WHEN COALESCE((SELECT filter_policy FROM channels WHERE channels.id = videos.channel_int), 3) = 4
       AND COALESCE(netfree_status, 0) = 1 THEN 1
  ELSE 0
END;

CREATE INDEX IF NOT EXISTS idx_videos_etrog_kind_lang_latest_cover
  ON videos(video_kind, language_code, published_at DESC, id DESC, video_id, title)
  WHERE etrog_visible = 1;

CREATE INDEX IF NOT EXISTS idx_videos_etrog_kind_lang_views
  ON videos(video_kind, language_code, view_count DESC, published_at DESC, id DESC, video_id, title)
  WHERE etrog_visible = 1
    AND view_count >= 2000;

CREATE INDEX IF NOT EXISTS idx_videos_etrog_channel_kind_lang_latest_cover
  ON videos(channel_int, video_kind, language_code, published_at DESC, id DESC, video_id, title)
  WHERE etrog_visible = 1;

CREATE INDEX IF NOT EXISTS idx_videos_etrog_channel_kind_lang_views_cover
  ON videos(channel_int, video_kind, language_code, IFNULL(view_count, 0) DESC, published_at DESC, id DESC, video_id, title)
  WHERE etrog_visible = 1;
