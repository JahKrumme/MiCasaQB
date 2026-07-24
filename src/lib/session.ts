import type { Env } from '../env';
import { randomToken, sha256Hex } from './crypto';
import { isRole, type User } from './users';

export const SESSION_COOKIE = 'mc_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export async function createSession(env: Env, userId: string): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;

  await env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`)
    .bind(tokenHash, userId, expiresAt, now)
    .run();

  return { token, expiresAt };
}

export async function destroySession(env: Env, token: string): Promise<void> {
  const tokenHash = await sha256Hex(token);
  await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
}

export type SessionUser = User;

export async function resolveSession(env: Env, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    `SELECT u.id as id, u.email as email, u.role as role, u.disabled as disabled,
            u.force_password_change as force_password_change,
            u.created_at as created_at, u.updated_at as updated_at, s.expires_at as expires_at
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  )
    .bind(tokenHash)
    .first<{
      id: string;
      email: string;
      role: string;
      disabled: number;
      force_password_change: number;
      created_at: number;
      updated_at: number;
      expires_at: number;
    }>();

  if (!row) return null;
  if (row.expires_at < Date.now()) {
    // Expired — clean up lazily and treat as unauthenticated.
    await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
    return null;
  }
  // A disabled account's sessions are deleted when it's disabled, but treat
  // this as unauthenticated defensively too, in case a session outlives that.
  if (row.disabled === 1) return null;

  const role = isRole(row.role) ? row.role : 'staff';
  return {
    id: row.id,
    email: row.email,
    role,
    isAdmin: role === 'admin',
    disabled: false,
    forcePasswordChange: row.force_password_change === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
