import type { Env } from '../env';
import { TokenRepository, type StoredConnection, type TokenBundle } from './tokenRepository';
import { exchangeCodeForTokens, isInvalidGrant, refreshAccessToken, revokeToken, type IntuitTokenResponse } from './intuitOAuth';

const REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh when <5 minutes of life remain

export class QboNotConnectedError extends Error {
  constructor() {
    super('QuickBooks is not connected');
    this.name = 'QboNotConnectedError';
  }
}

export class QboReauthRequiredError extends Error {
  constructor(message = 'QuickBooks connection needs to be re-authorized') {
    super(message);
    this.name = 'QboReauthRequiredError';
  }
}

export class QboApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'QboApiError';
  }
}

function tokenResponseToBundle(realmId: string, current: TokenBundle | null, resp: IntuitTokenResponse): TokenBundle {
  const now = Date.now();
  return {
    // The entire refresh response is authoritative — always take Intuit's
    // newest access AND refresh token, never reuse the old refresh token.
    access_token: resp.access_token,
    refresh_token: resp.refresh_token,
    token_type: resp.token_type,
    access_token_expires_at: now + resp.expires_in * 1000,
    refresh_token_expires_at:
      resp.x_refresh_token_expires_in != null ? now + resp.x_refresh_token_expires_in * 1000 : current?.refresh_token_expires_at ?? null,
    realm_id: realmId
  };
}

// Deduplicates concurrent refresh attempts within a single Worker isolate.
// Cross-isolate races are handled by optimistic concurrency on token_version.
const inFlightRefreshes = new Map<string, Promise<string>>();

async function performRefresh(env: Env, realmId: string, current: StoredConnection): Promise<string> {
  const repo = new TokenRepository(env);
  const expectedVersion = current.tokenVersion;

  let tokenResponse: IntuitTokenResponse;
  try {
    tokenResponse = await refreshAccessToken(env, current.bundle.refresh_token);
  } catch (err) {
    if (isInvalidGrant(err)) {
      // The refresh token Intuit knows about may have already been rotated by
      // a concurrent request that beat us here — reload before giving up.
      const latest = await repo.getConnection(realmId);
      if (latest && latest.tokenVersion !== expectedVersion && latest.bundle.access_token_expires_at - Date.now() > REFRESH_SKEW_MS) {
        return latest.bundle.access_token;
      }
      throw new QboReauthRequiredError('QuickBooks refresh token is no longer valid — reconnect required');
    }
    throw new QboReauthRequiredError('QuickBooks token refresh failed');
  }

  const newBundle = tokenResponseToBundle(realmId, current.bundle, tokenResponse);
  const { saved } = await repo.saveRefreshedTokens(realmId, expectedVersion, newBundle);

  if (!saved) {
    // Another request already persisted a newer token first. Discard our
    // result rather than overwrite it, and use whatever is now stored.
    const latest = await repo.getConnection(realmId);
    if (!latest) throw new QboReauthRequiredError('QuickBooks connection was removed during refresh');
    return latest.bundle.access_token;
  }

  return newBundle.access_token;
}

async function refreshWithSingleFlight(env: Env, realmId: string, current: StoredConnection): Promise<string> {
  const existing = inFlightRefreshes.get(realmId);
  if (existing) return existing;

  const promise = performRefresh(env, realmId, current).finally(() => {
    inFlightRefreshes.delete(realmId);
  });
  inFlightRefreshes.set(realmId, promise);
  return promise;
}

/**
 * The single entry point for obtaining a usable QuickBooks access token.
 * Returns the cached token if it has more than 5 minutes of life left,
 * otherwise refreshes (with single-flight + optimistic concurrency
 * protection) and returns the newly persisted token.
 */
export async function getValidQuickBooksAccessToken(env: Env, realmId: string): Promise<string> {
  const repo = new TokenRepository(env);
  const connection = await repo.getConnection(realmId);
  if (!connection) throw new QboNotConnectedError();

  if (connection.bundle.access_token_expires_at - Date.now() > REFRESH_SKEW_MS) {
    return connection.bundle.access_token;
  }

  return refreshWithSingleFlight(env, realmId, connection);
}

/** Forces a refresh regardless of expiry — used for the 401-retry-once path. */
export async function forceRefreshAccessToken(env: Env, realmId: string): Promise<string> {
  const repo = new TokenRepository(env);
  const connection = await repo.getConnection(realmId);
  if (!connection) throw new QboNotConnectedError();
  return refreshWithSingleFlight(env, realmId, connection);
}

export async function connectNewRealm(env: Env, code: string, realmId: string, redirectUri: string): Promise<void> {
  const tokenResponse = await exchangeCodeForTokens(env, code, redirectUri);
  const bundle = tokenResponseToBundle(realmId, null, tokenResponse);
  const repo = new TokenRepository(env);
  await repo.upsertConnection(realmId, bundle);
}

export async function disconnectRealm(env: Env, realmId: string): Promise<void> {
  const repo = new TokenRepository(env);
  const connection = await repo.getConnection(realmId).catch(() => null);
  if (connection) {
    await revokeToken(env, connection.bundle.refresh_token);
  }
  await repo.deleteConnection(realmId);
}

function apiBase(env: Env): string {
  return env.INTUIT_ENVIRONMENT === 'sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
}

/**
 * Makes an authenticated QuickBooks API request. On a 401 it refreshes the
 * token exactly once and retries the request exactly once — never more.
 */
async function qbApiRequest(env: Env, realmId: string, path: string, init: RequestInit = {}): Promise<unknown> {
  const url = `${apiBase(env)}/v3/company/${realmId}/${path}`;

  const doRequest = async (accessToken: string) =>
    fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json'
      }
    });

  const accessToken = await getValidQuickBooksAccessToken(env, realmId);
  let response = await doRequest(accessToken);

  if (response.status === 401) {
    const refreshedToken = await forceRefreshAccessToken(env, realmId);
    response = await doRequest(refreshedToken);
  }

  if (!response.ok) {
    // Never log response bodies here — they can contain company financial data.
    console.error(`[QB API ERROR] status=${response.status} path=${path.split('?')[0]}`);
    throw new QboApiError(response.status, `QuickBooks API request failed (${response.status})`);
  }

  return response.json();
}

export async function qbQuery(env: Env, realmId: string, query: string): Promise<any> {
  return qbApiRequest(env, realmId, `query?query=${encodeURIComponent(query)}&minorversion=65`);
}

export async function qbCreate(env: Env, realmId: string, endpoint: string, body: unknown): Promise<any> {
  return qbApiRequest(env, realmId, `${endpoint}?minorversion=65`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}
