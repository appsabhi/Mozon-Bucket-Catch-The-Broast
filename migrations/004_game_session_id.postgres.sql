-- Add the session key to older PostgreSQL installations without changing existing rows.
ALTER TABLE leaderboard
  ADD COLUMN IF NOT EXISTS game_session_id VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS uq_leaderboard_game_session_id
  ON leaderboard (game_session_id);
