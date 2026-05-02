-- Netfree compact checker optimization
-- Run this before using the new Chrome extension.

-- Make sure every pending row has a deterministic discovery timestamp.
UPDATE videos
SET netfree_discovered_at = COALESCE(netfree_discovered_at, updated_at, published_at, strftime('%s','now'))
WHERE netfree_discovered_at IS NULL
   OR netfree_discovered_at = 0;

-- Make old status-5 rows eligible for one recheck manifest if they have no due date.
UPDATE videos
SET netfree_recheck_after = strftime('%s','now')
WHERE netfree_status = 5
  AND (netfree_recheck_after IS NULL OR netfree_recheck_after = 0);

-- Remove older queue indexes that were built around checked/claimed columns.
DROP INDEX IF EXISTS idx_videos_netfree_queue;
DROP INDEX IF EXISTS idx_videos_netfree_recheck_queue;
DROP INDEX IF EXISTS idx_videos_netfree_pending_age_queue;
DROP INDEX IF EXISTS idx_videos_netfree_recheck_due_queue;

-- Fast manifest for: status 0 + discovered age.
CREATE INDEX IF NOT EXISTS idx_videos_netfree_pending_manifest
  ON videos(netfree_status, netfree_discovered_at, id, video_id);

-- Fast manifest for: status 5 + due recheck date.
CREATE INDEX IF NOT EXISTS idx_videos_netfree_recheck_manifest
  ON videos(netfree_status, netfree_recheck_after, id, video_id);

-- Optional cleanup AFTER the new project files are deployed and verified.
-- Run one-by-one only if your SQLite/Turso version allows DROP COLUMN.
-- If one of these commands fails, leave the column; unused columns do not cost reads/writes.
-- ALTER TABLE videos DROP COLUMN netfree_checked_at;
-- ALTER TABLE videos DROP COLUMN netfree_check_attempts;
-- ALTER TABLE videos DROP COLUMN netfree_last_error;
-- ALTER TABLE videos DROP COLUMN netfree_claimed_at;
-- ALTER TABLE videos DROP COLUMN netfree_claimed_by;
