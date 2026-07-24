import { describe, expect, it } from 'vitest';
import { createOAuthState, validateAndConsumeOAuthState } from '../src/lib/oauthState';
import { createTestEnv } from './helpers/testEnv';

describe('OAuth state validation', () => {
  it('accepts a fresh, matching, single-use state for the initiating user', async () => {
    const env = createTestEnv();
    const state = await createOAuthState(env, 'user-1');
    const result = await validateAndConsumeOAuthState(env, state, state, 'user-1');
    expect(result.ok).toBe(true);
  });

  it('rejects a missing state', async () => {
    const env = createTestEnv();
    const result = await validateAndConsumeOAuthState(env, undefined, undefined, 'user-1');
    expect(result).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects a mismatched state (cookie vs. callback param differ)', async () => {
    const env = createTestEnv();
    const state = await createOAuthState(env, 'user-1');
    const result = await validateAndConsumeOAuthState(env, state, 'something-else', 'user-1');
    expect(result).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('rejects reuse of an already-consumed state', async () => {
    const env = createTestEnv();
    const state = await createOAuthState(env, 'user-1');

    const first = await validateAndConsumeOAuthState(env, state, state, 'user-1');
    expect(first.ok).toBe(true);

    const second = await validateAndConsumeOAuthState(env, state, state, 'user-1');
    expect(second).toEqual({ ok: false, reason: 'reused' });
  });

  it('rejects an expired state', async () => {
    const env = createTestEnv();
    const state = await createOAuthState(env, 'user-1');
    // Force expiry directly in the store.
    await env.DB.prepare('UPDATE oauth_state SET expires_at = ? WHERE state = ?').bind(Date.now() - 1000, state).run();

    const result = await validateAndConsumeOAuthState(env, state, state, 'user-1');
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects state issued to a different user session', async () => {
    const env = createTestEnv();
    const state = await createOAuthState(env, 'user-1');
    const result = await validateAndConsumeOAuthState(env, state, state, 'user-2');
    expect(result).toEqual({ ok: false, reason: 'wrong_user' });
  });

  it('rejects two concurrent consumption attempts of the same state — only one wins', async () => {
    const env = createTestEnv();
    const state = await createOAuthState(env, 'user-1');

    const [first, second] = await Promise.all([
      validateAndConsumeOAuthState(env, state, state, 'user-1'),
      validateAndConsumeOAuthState(env, state, state, 'user-1')
    ]);

    const okCount = [first, second].filter(r => r.ok).length;
    expect(okCount).toBe(1);
  });
});
