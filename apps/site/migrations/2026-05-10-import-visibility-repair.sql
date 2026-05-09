-- Repair for channel import visibility after moving to language/netfree-aware project 3.
-- Safe to run more than once after the language/netfree columns already exist.

CREATE TABLE IF NOT EXISTS channel_languages (
  channel_int INTEGER NOT NULL,
  language_code TEXT NOT NULL,
  source TEXT DEFAULT '',
  PRIMARY KEY (channel_int, language_code)
);

CREATE INDEX IF NOT EXISTS idx_channel_languages_lookup
  ON channel_languages(language_code, channel_int);

-- Keep old/imported rows visible unless the admin explicitly hid them.
UPDATE channels
SET show_in_public_channels = 1
WHERE show_in_public_channels IS NULL;

UPDATE channels
SET netfree_default_status = 1
WHERE netfree_default_status IS NULL;

-- Rebuild channel language index from the channel row itself.
INSERT OR IGNORE INTO channel_languages(channel_int, language_code, source)
SELECT id, language_code, COALESCE(NULLIF(language_source, ''), 'repair:channels.language_code')
FROM channels
WHERE language_code IN ('he', 'en', 'fr', 'yi', 'ru');

-- Rebuild from languages_json when it is valid JSON.
INSERT OR IGNORE INTO channel_languages(channel_int, language_code, source)
SELECT c.id, j.value, 'repair:channels.languages_json'
FROM channels AS c
JOIN json_each(
  CASE
    WHEN json_valid(COALESCE(c.languages_json, '')) THEN c.languages_json
    ELSE '[]'
  END
) AS j
WHERE j.value IN ('he', 'en', 'fr', 'yi', 'ru');

-- Rebuild from imported videos, so a channel appears under a language if it has videos in that language.
INSERT OR IGNORE INTO channel_languages(channel_int, language_code, source)
SELECT DISTINCT channel_int, language_code, 'repair:videos.language_code'
FROM videos
WHERE channel_int IS NOT NULL
  AND language_code IN ('he', 'en', 'fr', 'yi', 'ru');
