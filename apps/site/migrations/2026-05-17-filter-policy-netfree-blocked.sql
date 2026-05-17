-- Adds policy values 5/6 to channel filtering logic. No schema change is required.
-- 5 = NetFree fully blocked, Etrog fully open.
-- 6 = NetFree fully blocked, Etrog sensitive.
-- Run only if you want to repair existing rows that accidentally got unsupported policy values.

UPDATE channels
SET filter_policy = 0
WHERE filter_policy IS NOT NULL
  AND filter_policy NOT IN (0, 1, 2, 3, 4, 5, 6);
