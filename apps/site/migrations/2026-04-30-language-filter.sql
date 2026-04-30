-- Language filtering upgrade for Youtora
-- Run ALTER TABLE statements one by one if your SQL editor stops on duplicate columns.

ALTER TABLE channels ADD COLUMN language_code TEXT DEFAULT '';
ALTER TABLE channels ADD COLUMN language_source TEXT DEFAULT '';
ALTER TABLE channels ADD COLUMN languages_json TEXT DEFAULT '[]';

ALTER TABLE videos ADD COLUMN language_code TEXT DEFAULT '';
ALTER TABLE videos ADD COLUMN language_source TEXT DEFAULT '';

CREATE TABLE IF NOT EXISTS channel_languages (
  channel_int INTEGER NOT NULL,
  language_code TEXT NOT NULL,
  source TEXT DEFAULT '',
  PRIMARY KEY (channel_int, language_code)
);

CREATE INDEX IF NOT EXISTS idx_channel_languages_lookup
  ON channel_languages(language_code, channel_int);

CREATE INDEX IF NOT EXISTS idx_channels_language_active_title
  ON channels(language_code, is_active, title);

CREATE INDEX IF NOT EXISTS idx_videos_lang_latest_cover
  ON videos(language_code, published_at DESC, id DESC, video_id, title);

CREATE INDEX IF NOT EXISTS idx_videos_kind_lang_latest_cover
  ON videos(video_kind, language_code, published_at DESC, id DESC, video_id, title);

CREATE INDEX IF NOT EXISTS idx_videos_channel_lang_latest_cover
  ON videos(channel_int, language_code, published_at DESC, id DESC, video_id, title);

CREATE INDEX IF NOT EXISTS idx_videos_channel_kind_lang_latest_cover
  ON videos(channel_int, video_kind, language_code, published_at DESC, id DESC, video_id, title);
