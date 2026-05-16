-- Channel page popularity sort indexes.
-- כל תצוגות הסרטונים הציבוריות מחולקות לפי video_kind:
-- V = סרטון רגיל, S = שורט, L = שידור חי.
-- לכן צריך רק את אינדקס הצפיות לפי ערוץ+סוג+שפה.
-- אינדקסים בלי video_kind ואינדקסי likes הוסרו כדי לחסוך מקום.

CREATE INDEX IF NOT EXISTS idx_videos_public_channel_kind_lang_views_cover
  ON videos(channel_int, netfree_status, video_kind, language_code, IFNULL(view_count, 0) DESC, published_at DESC, id DESC, video_id, title);

