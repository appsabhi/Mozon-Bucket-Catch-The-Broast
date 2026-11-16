-- Track server-issued game sessions to prevent submission replay attacks.
CREATE TABLE IF NOT EXISTS game_sessions (
  session_id VARCHAR(64) PRIMARY KEY,
  player_id VARCHAR(64) NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  score INTEGER,
  food_caught INTEGER
);

CREATE INDEX IF NOT EXISTS idx_game_sessions_player ON game_sessions (player_id);
CREATE INDEX IF NOT EXISTS idx_game_sessions_expiry ON game_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_game_sessions_unused ON game_sessions (session_id) WHERE used_at IS NULL;
