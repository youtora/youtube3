-- General site popularity indexes for /api/latest?sort=views.
-- These are NOT channel-page indexes.
-- They replace the earlier slim general views indexes with partial covering indexes.
-- Partial condition: only public videos with 2000+ views are stored in these indexes.

DROP INDEX IF EXISTS idx_videos_public_lang_views;
DROP INDEX IF EXISTS idx_videos_public_kind_lang_views;

CREATE INDEX idx_videos_public_lang_views
  ON videos(
    language_code,
    view_count DESC,
    published_at DESC,
    id DESC,
    video_id,
    title,
    video_kind,
    duration_sec,
    like_count,
    comment_count,
    language_source,
    channel_int
  )
  WHERE netfree_status = 1
    AND view_count >= 2000;

CREATE INDEX idx_videos_public_kind_lang_views
  ON videos(
    video_kind,
    language_code,
    view_count DESC,
    published_at DESC,
    id DESC,
    video_id,
    title,
    duration_sec,
    like_count,
    comment_count,
    language_source,
    channel_int
  )
  WHERE netfree_status = 1
    AND view_count >= 2000;
