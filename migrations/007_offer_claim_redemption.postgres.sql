-- Staff offer redemption (admin "Claim" button). Additive only: no existing rows are changed.
-- A staff-confirmed claim sets claim_status = 'claimed' and records when it happened.
ALTER TABLE offer_claims
  ADD COLUMN IF NOT EXISTS redeemed_at TIMESTAMPTZ;

-- Customers are identified by their MSG91-verified mobile number. The database allows at most one
-- staff-confirmed claim per verified mobile and offer, even under concurrent requests. Rows with
-- any other status (e.g. 'unlocked') are unaffected.
-- (Replaces a per-player index from an unreleased draft of this migration; never in production.)
DROP INDEX IF EXISTS uq_offer_claims_player_offer_claimed;
CREATE UNIQUE INDEX IF NOT EXISTS uq_offer_claims_mobile_offer_claimed
  ON offer_claims ((regexp_replace(mobile_number, '[^0-9]', '', 'g')), offer_id)
  WHERE claim_status = 'claimed';

CREATE INDEX IF NOT EXISTS idx_player_sessions_player ON player_sessions (player_id);
