-- שלב 2ב: סטטוס "נטפרי עדיין לא בדקו" + תאריך בדיקה חוזרת
-- להריץ פעם אחת לפני העלאת הקוד של שלב 2ב.

ALTER TABLE videos ADD COLUMN netfree_recheck_after INTEGER;

CREATE INDEX IF NOT EXISTS idx_videos_netfree_recheck_queue
  ON videos(netfree_status, netfree_recheck_after, view_count DESC, published_at DESC, id DESC);
