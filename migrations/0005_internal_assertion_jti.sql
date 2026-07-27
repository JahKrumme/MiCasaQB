-- Replay protection for the Hub's signed service assertions (see
-- src/lib/serviceAssertion.ts, src/middleware/internalAuth.ts). Assertions
-- are short-lived (60s), so this table only ever needs to hold a handful of
-- rows at once — expired rows are pruned opportunistically by the
-- middleware rather than needing a separate cron job.
CREATE TABLE IF NOT EXISTS internal_assertion_jti (
  jti        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS internal_assertion_jti_expires_idx ON internal_assertion_jti(expires_at);
