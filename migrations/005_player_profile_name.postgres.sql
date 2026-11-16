ALTER TABLE players
  ADD COLUMN IF NOT EXISTS profile_name VARCHAR(64);

UPDATE players
SET profile_name = display_name
WHERE profile_name IS NULL
  AND display_name IS NOT NULL
  AND BTRIM(display_name) <> ''
  AND display_name <> 'Anonymous Feast Guest'
  AND display_name <> 'MandiGuest'
  AND LEFT(display_name, 11) <> 'MandiGuest_';
