-- Normalize regular videos to explicit video_kind='V'.
-- This keeps /videos, /shorts, and /live fully separated and index-friendly.

UPDATE videos
SET video_kind = 'V'
WHERE video_kind IS NULL
   OR video_kind = '';
