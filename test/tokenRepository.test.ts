import { describe, expect, it } from 'vitest';
import { createTestEnv } from './helpers/testEnv';
import { TokenRepository, type TokenBundle } from '../src/lib/tokenRepository';

function bundle(realmId: string, accessToken: string): TokenBundle {
  const now = Date.now();
  return {
    access_token: accessToken,
    refresh_token: 'refresh-token',
    token_type: 'bearer',
    access_token_expires_at: now + 3600_000,
    refresh_token_expires_at: now + 100 * 24 * 60 * 60 * 1000,
    realm_id: realmId
  };
}

describe('TokenRepository optimistic concurrency', () => {
  it('saves successfully when the expected version matches', async () => {
    const env = createTestEnv();
    const realmId = `realm-${crypto.randomUUID()}`;
    const repo = new TokenRepository(env);

    await repo.upsertConnection(realmId, bundle(realmId, 'v1'));
    const result = await repo.saveRefreshedTokens(realmId, 1, bundle(realmId, 'v2'));

    expect(result.saved).toBe(true);
    const stored = await repo.getConnection(realmId);
    expect(stored?.bundle.access_token).toBe('v2');
    expect(stored?.tokenVersion).toBe(2);
  });

  it('refuses to save (without throwing) when the expected version is stale', async () => {
    const env = createTestEnv();
    const realmId = `realm-${crypto.randomUUID()}`;
    const repo = new TokenRepository(env);

    await repo.upsertConnection(realmId, bundle(realmId, 'v1'));
    // Someone else already refreshed to v2.
    await repo.saveRefreshedTokens(realmId, 1, bundle(realmId, 'v2'));

    // We still think we're at version 1 — must not clobber v2.
    const staleResult = await repo.saveRefreshedTokens(realmId, 1, bundle(realmId, 'stale-overwrite'));
    expect(staleResult.saved).toBe(false);

    const stored = await repo.getConnection(realmId);
    expect(stored?.bundle.access_token).toBe('v2');
  });

  it('never stores plaintext token fields — only ciphertext and IV columns', async () => {
    const env = createTestEnv();
    const realmId = `realm-${crypto.randomUUID()}`;
    await new TokenRepository(env).upsertConnection(realmId, bundle(realmId, 'super-secret-access-token'));

    const row = await env.DB.prepare('SELECT * FROM qbo_connections WHERE realm_id = ?').bind(realmId).first<Record<string, unknown>>();
    const rawColumns = JSON.stringify(row);
    expect(rawColumns).not.toContain('super-secret-access-token');
    expect(rawColumns).not.toContain('refresh-token');
    expect(row?.encrypted_token_bundle).toBeTruthy();
    expect(row?.encryption_iv).toBeTruthy();
  });
});
