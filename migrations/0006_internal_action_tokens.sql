-- Short-lived, single-use confirmation tokens for internal (Hub/CRM-facing)
-- write actions that need a prepare -> confirm -> record split to avoid a
-- retried network request double-charging or double-creating a QuickBooks
-- record. Same idempotent-consumption discipline as oauth_state
-- (validateAndConsumeOAuthState) and MiCasaCRM's hub_handoff_codes: claimed
-- via an UPDATE ... WHERE used_at IS NULL, so a concurrent double-use can't
-- both succeed.
CREATE TABLE IF NOT EXISTS internal_action_tokens (
  token_hash   TEXT PRIMARY KEY,
  action       TEXT NOT NULL,           -- e.g. 'record_payment'
  payload_hash TEXT NOT NULL,           -- SHA-256 hex of the exact confirmed payload JSON
  created_by   TEXT NOT NULL,           -- the signed assertion's `sub` (acting CRM user's email)
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  used_at      INTEGER
);

CREATE INDEX IF NOT EXISTS internal_action_tokens_expires_idx ON internal_action_tokens(expires_at);
