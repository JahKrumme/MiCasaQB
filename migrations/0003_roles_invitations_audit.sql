-- Role-based access (replaces the boolean is_admin with a three-way role),
-- account lifecycle (disabled / forced password change), invite-only
-- onboarding, and an audit trail for admin/security-relevant actions.

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'staff';
UPDATE users SET role = 'admin' WHERE is_admin = 1;
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN force_password_change INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users DROP COLUMN is_admin;

-- Single-use, time-limited invitations. Only a hash of the token is ever
-- stored — the raw token exists only in the emailed link and the admin's
-- one-time API response (on email-send failure, as a manual fallback).
CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email);

-- Append-only record of admin/security-relevant actions. metadata is a JSON
-- blob of non-sensitive details only (roles, emails, realm ids) — never
-- passwords, hashes, tokens, or secrets.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  actor_email TEXT,
  action TEXT NOT NULL,
  target TEXT,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
