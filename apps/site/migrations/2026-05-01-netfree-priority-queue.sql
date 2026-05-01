-- שלב 2ג: תור בדיקה לפי זמן, בלי פופולריות.
-- חשוב: SQLite/Turso לא תמיד תומך ב-ADD COLUMN IF NOT EXISTS.
-- לכן אם עמודה כבר קיימת, אל תריץ שוב את שורת ה-ALTER שלה.

-- אם עדיין לא הרצת את שלב 2ב, צריך גם את העמודה הזאת:
ALTER TABLE videos ADD COLUMN netfree_recheck_after INTEGER;

-- עמודה חדשה שמחזיקה מתי הסרטון נכנס לתור הבדיקה.
ALTER TABLE videos ADD COLUMN netfree_discovered_at INTEGER;

-- מילוי ערך התחלתי לסרטונים שכבר קיימים.
UPDATE videos
SET netfree_discovered_at = COALESCE(updated_at, published_at, strftime('%s','now'))
WHERE netfree_discovered_at IS NULL
   OR netfree_discovered_at = 0;

-- אינדקס ישן משלב 2ב, אם נוצר לפי פופולריות, כבר לא צריך.
DROP INDEX IF EXISTS idx_videos_netfree_recheck_queue;

CREATE INDEX IF NOT EXISTS idx_videos_netfree_pending_age_queue
  ON videos(netfree_status, netfree_discovered_at, netfree_checked_at, published_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_videos_netfree_recheck_due_queue
  ON videos(netfree_status, netfree_recheck_after, netfree_checked_at, published_at DESC, id DESC);
