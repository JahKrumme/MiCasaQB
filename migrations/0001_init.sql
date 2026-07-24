-- Mi Casa QuickBooks Assistant — initial D1 schema
-- Timestamps are stored as Unix epoch milliseconds (INTEGER) unless noted.

-- QuickBooks OAuth connection. Tokens are AES-256-GCM encrypted application-side
-- before storage — this table never holds plaintext access/refresh tokens.
CREATE TABLE IF NOT EXISTS qbo_connections (
  realm_id TEXT PRIMARY KEY,
  encrypted_token_bundle TEXT NOT NULL,
  encryption_iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  access_token_expires_at INTEGER NOT NULL,
  refresh_token_expires_at INTEGER,
  token_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Mi Casa staff accounts (replaces Google OAuth + Supabase allowed_emails allowlist).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  iterations INTEGER NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Server-side session records. The cookie holds only an opaque random token;
-- this table stores a SHA-256 hash of it, never the raw token.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

-- Short-lived, single-use QuickBooks OAuth CSRF state, bound to the initiating
-- session so the callback can confirm it belongs to the same authenticated user.
CREATE TABLE IF NOT EXISTS oauth_state (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

-- Simple fixed-window rate limiting for auth/OAuth endpoints.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
