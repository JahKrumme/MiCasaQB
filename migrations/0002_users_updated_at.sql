-- Track when a user's row (password, admin status, etc.) was last changed,
-- so create-admin's upsert path and /api/admin can report an update time
-- distinct from created_at.
ALTER TABLE users ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
UPDATE users SET updated_at = created_at WHERE updated_at = 0;
