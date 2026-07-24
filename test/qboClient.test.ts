import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv } from './helpers/testEnv';
import { withFailingWrite } from './helpers/failingD1';
import { TokenRepository, type TokenBundle } from '../src/lib/tokenRepository';
import {
  forceRefreshAccessToken,
  getValidQuickBooksAccessToken,
  qbQuery,
  QboApiError,
  QboReauthRequiredError
} from '../src/lib/qboClient';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function freshBundle(realmId: string, overrides: Partial<TokenBundle> = {}): TokenBundle {
  const now = Date.now();
  return {
    access_token: 'initial-access-token',
    refresh_token: 'initial-refresh-token',
    token_type: 'bearer',
    access_token_expires_at: now + 60 * 60 * 1000, // 1 hour out — not expiring soon
    refresh_token_expires_at: now + 100 * 24 * 60 * 60 * 1000,
    realm_id: realmId,
    ...overrides
  };
}

function expiredBundle(realmId: string, overrides: Partial<TokenBundle> = {}): TokenBundle {
  return freshBundle(realmId, { access_token_expires_at: Date.now() - 1000, ...overrides });
}

function uniqueRealmId(): string {
  return `realm-${crypto.randomUUID()}`;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockSuccessfulRefresh(newAccessToken: string, newRefreshToken: string) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url === TOKEN_URL) {
      return new Response(
        JSON.stringify({
          access_token: newAccessToken,
          refresh_token: newRefreshToken,
          token_type: 'bearer',
          expires_in: 3600,
          x_refresh_token_expires_in: 100 * 24 * 60 * 60
        }),
        { status: 200 }
      );
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

describe('getValidQuickBooksAccessToken', () => {
  it('returns the cached access token when it has more than 5 minutes left', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));

    const token = await getValidQuickBooksAccessToken(env, realmId);
    expect(token).toBe('initial-access-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes when the access token is expired, and persists the new tokens', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(env).upsertConnection(realmId, expiredBundle(realmId, { refresh_token: 'old-refresh' }));
    mockSuccessfulRefresh('new-access-token', 'new-refresh-token');

    const token = await getValidQuickBooksAccessToken(env, realmId);
    expect(token).toBe('new-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The newest bundle, including the NEW refresh token, must be what's stored.
    const stored = await new TokenRepository(env).getConnection(realmId);
    expect(stored?.bundle.access_token).toBe('new-access-token');
    expect(stored?.bundle.refresh_token).toBe('new-refresh-token');
    expect(stored?.tokenVersion).toBe(2);
  });

  it('throws QboNotConnectedError-derived error and never returns a token when the DB save fails after a successful Intuit refresh', async () => {
    const baseEnv = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(baseEnv).upsertConnection(realmId, expiredBundle(realmId));
    mockSuccessfulRefresh('should-never-be-returned', 'should-never-be-saved');

    const env = { ...baseEnv, DB: withFailingWrite(baseEnv.DB, 'UPDATE qbo_connections SET') };

    await expect(getValidQuickBooksAccessToken(env, realmId)).rejects.toThrow();

    // Confirm nothing was persisted despite Intuit having "succeeded".
    const stored = await new TokenRepository(baseEnv).getConnection(realmId);
    expect(stored?.bundle.access_token).toBe('initial-access-token');
  });

  it('deduplicates two simultaneous refresh attempts into a single upstream call', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(env).upsertConnection(realmId, expiredBundle(realmId));
    mockSuccessfulRefresh('concurrent-access-token', 'concurrent-refresh-token');

    const [tokenA, tokenB] = await Promise.all([
      getValidQuickBooksAccessToken(env, realmId),
      getValidQuickBooksAccessToken(env, realmId)
    ]);

    expect(tokenA).toBe('concurrent-access-token');
    expect(tokenB).toBe('concurrent-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reloads the D1 record on invalid_grant instead of failing immediately if a newer token already landed', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    const repo = new TokenRepository(env);
    await repo.upsertConnection(realmId, expiredBundle(realmId, { refresh_token: 'stale-refresh' }));

    fetchMock.mockImplementation(async (url: string) => {
      if (url === TOKEN_URL) {
        // Simulate a concurrent winner landing a newer token in D1 the moment
        // our refresh call reaches Intuit, which is why Intuit now rejects it.
        await repo.saveRefreshedTokens(realmId, 1, freshBundle(realmId, { access_token: 'winner-access-token', refresh_token: 'winner-refresh-token' }));
        return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const token = await getValidQuickBooksAccessToken(env, realmId);
    expect(token).toBe('winner-access-token');
  });

  it('fails with a reauth-required error on invalid_grant when no newer token exists', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(env).upsertConnection(realmId, expiredBundle(realmId));

    fetchMock.mockImplementation(async (url: string) => {
      if (url === TOKEN_URL) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
      throw new Error(`Unexpected fetch to ${url}`);
    });

    await expect(getValidQuickBooksAccessToken(env, realmId)).rejects.toThrow(QboReauthRequiredError);
  });
});

describe('qbQuery 401-retry-once behavior', () => {
  it('refreshes once and retries once on a 401, then succeeds', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId, { access_token: 'stale-but-not-expired' }));

    let qbApiCallCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === TOKEN_URL) {
        return new Response(
          JSON.stringify({ access_token: 'refreshed-access-token', refresh_token: 'refreshed-refresh-token', token_type: 'bearer', expires_in: 3600 }),
          { status: 200 }
        );
      }
      if (url.includes('/query')) {
        qbApiCallCount++;
        const authHeader = (init?.headers as Record<string, string>)?.Authorization;
        if (authHeader === 'Bearer stale-but-not-expired') {
          return new Response('Unauthorized', { status: 401 });
        }
        if (authHeader === 'Bearer refreshed-access-token') {
          return new Response(JSON.stringify({ QueryResponse: { Customer: [] } }), { status: 200 });
        }
        return new Response('Unexpected token', { status: 401 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    const result = await qbQuery(env, realmId, 'SELECT * FROM Customer');
    expect(result.QueryResponse.Customer).toEqual([]);
    expect(qbApiCallCount).toBe(2); // one 401, one retry — never more
  });

  it('never loops infinitely — a second consecutive 401 after the one retry throws', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId, { access_token: 'stale-token' }));

    let qbApiCallCount = 0;
    fetchMock.mockImplementation(async (url: string) => {
      if (url === TOKEN_URL) {
        return new Response(
          JSON.stringify({ access_token: 'still-rejected-token', refresh_token: 'r2', token_type: 'bearer', expires_in: 3600 }),
          { status: 200 }
        );
      }
      if (url.includes('/query')) {
        qbApiCallCount++;
        return new Response('Unauthorized', { status: 401 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    });

    await expect(qbQuery(env, realmId, 'SELECT * FROM Customer')).rejects.toThrow(QboApiError);
    expect(qbApiCallCount).toBe(2); // initial + exactly one retry, not a third attempt
  });
});

describe('forceRefreshAccessToken', () => {
  it('refreshes even when the current token has not expired', async () => {
    const env = createTestEnv();
    const realmId = uniqueRealmId();
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));
    mockSuccessfulRefresh('forced-new-token', 'forced-new-refresh');

    const token = await forceRefreshAccessToken(env, realmId);
    expect(token).toBe('forced-new-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
