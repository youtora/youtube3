-- Channel page popularity sort indexes.
-- Your DB already has the latest/oldest channel indexes.
-- This migration adds only the missing views/likes indexes used by /api/channel?sort=views|likes.

CREATE INDEX IF NOT EXISTS idx_videos_public_channel_lang_views_cover
  ON videos(channel_int, netfree_status, language_code, IFNULL(view_count, 0) DESC, published_at DESC, id DESC, video_id, title);

CREATE INDEX IF NOT EXISTS idx_videos_public_channel_kind_lang_views_cover
  ON videos(channel_int, netfree_status, video_kind, language_code, IFNULL(view_count, 0) DESC, published_at DESC, id DESC, video_id, title);

CREATE INDEX IF NOT EXISTS idx_videos_public_channel_lang_likes_cover
  ON videos(channel_int, netfree_status, language_code, IFNULL(like_count, 0) DESC, published_at DESC, id DESC, video_id, title);

CREATE INDEX IF NOT EXISTS idx_videos_public_channel_kind_lang_likes_cover
  ON videos(channel_int, netfree_status, video_kind, language_code, IFNULL(like_count, 0) DESC, published_at DESC, id DESC, video_id, title);
