-- Persistent player authentication sessions. Raw cookie tokens are never stored.
CREATE TABLE IF NOT EXISTS player_sessions (
  session_token_hash CHAR(64) PRIMARY KEY,
  player_id VARCHAR(64) NOT NULL,
  mobile_number VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_player_sessions_mobile ON player_sessions (mobile_number);
CREATE INDEX IF NOT EXISTS idx_player_sessions_expiry ON player_sessions (expires_at);
