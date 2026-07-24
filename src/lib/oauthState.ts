import type { Env } from '../env';
import { randomToken } from './crypto';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the OAuth round trip

export async function createOAuthState(env: Env, userId: string): Promise<string> {
  const state = randomToken(24);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO oauth_state (state, user_id, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)`)
    .bind(state, userId, now, now + STATE_TTL_MS)
    .run();
  return state;
}

export type OAuthStateResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'mismatch' | 'expired' | 'reused' | 'wrong_user' };

/**
 * Validates and atomically consumes an OAuth state value. Rejects missing,
 * mismatched (cookie vs. callback param), expired, reused, or user-mismatched
 * state. The UPDATE ... WHERE used = 0 makes consumption atomic — a replayed
 * callback can never mark the same state used twice.
 */
export async function validateAndConsumeOAuthState(
  env: Env,
  cookieState: string | undefined,
  callbackState: string | undefined,
  currentUserId: string
): Promise<OAuthStateResult> {
  if (!cookieState || !callbackState) return { ok: false, reason: 'missing' };
  if (cookieState !== callbackState) return { ok: false, reason: 'mismatch' };

  const row = await env.DB.prepare(`SELECT user_id, expires_at, used FROM oauth_state WHERE state = ?`)
    .bind(callbackState)
    .first<{ user_id: string; expires_at: number; used: number }>();

  if (!row) return { ok: false, reason: 'missing' };
  if (row.used === 1) return { ok: false, reason: 'reused' };
  if (row.expires_at < Date.now()) return { ok: false, reason: 'expired' };
  if (row.user_id !== currentUserId) return { ok: false, reason: 'wrong_user' };

  const consumed = await env.DB.prepare(`UPDATE oauth_state SET used = 1 WHERE state = ? AND used = 0`).bind(callbackState).run();
  if ((consumed.meta.changes ?? 0) === 0) return { ok: false, reason: 'reused' };

  return { ok: true };
}
