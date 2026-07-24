import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv } from './helpers/testEnv';
import { exchangeCodeForTokens, IntuitOAuthError } from '../src/lib/intuitOAuth';
import { connectNewRealm } from '../src/lib/qboClient';
import { TokenRepository } from '../src/lib/tokenRepository';

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const PROD_REDIRECT_URI = 'https://qb-assistant.elijahkrumme.workers.dev/api/qbo/callback';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function successResponse() {
  return new Response(
    JSON.stringify({
      access_token: 'brand-new-access-token',
      refresh_token: 'brand-new-refresh-token',
      token_type: 'bearer',
      expires_in: 3600,
      x_refresh_token_expires_in: 100 * 24 * 60 * 60
    }),
    { status: 200 }
  );
}

describe('exchangeCodeForTokens', () => {
  it('POSTs to the official Intuit token endpoint exactly once', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(successResponse());

    await exchangeCodeForTokens(env, 'auth-code-123', PROD_REDIRECT_URI);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe(TOKEN_URL);
  });

  it('sends the correct method and headers', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(successResponse());

    await exchangeCodeForTokens(env, 'auth-code-123', PROD_REDIRECT_URI);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(init.headers['Accept']).toBe('application/json');
  });

  it('authenticates with HTTP Basic base64(client_id:client_secret)', async () => {
    const env = createTestEnv({ INTUIT_CLIENT_ID: 'my-client-id', INTUIT_CLIENT_SECRET: 'my-client-secret' });
    fetchMock.mockResolvedValue(successResponse());

    await exchangeCodeForTokens(env, 'auth-code-123', PROD_REDIRECT_URI);

    const [, init] = fetchMock.mock.calls[0]!;
    const expected = `Basic ${btoa('my-client-id:my-client-secret')}`;
    expect(init.headers.Authorization).toBe(expected);
  });

  it('sends an exact form-encoded body with grant_type, code, and redirect_uri', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(successResponse());

    await exchangeCodeForTokens(env, 'auth-code-123', PROD_REDIRECT_URI);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('auth-code-123');
    expect(body.get('redirect_uri')).toBe(PROD_REDIRECT_URI);
    expect(Array.from(body.keys()).sort()).toEqual(['code', 'grant_type', 'redirect_uri']);
  });

  it('uses the exact production redirect_uri string, unmodified (no trim/decode drift)', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(successResponse());
    const redirectUriWithNoSurprises = 'https://qb-assistant.elijahkrumme.workers.dev/api/qbo/callback';

    await exchangeCodeForTokens(env, 'auth-code-123', redirectUriWithNoSurprises);

    const [, init] = fetchMock.mock.calls[0]!;
    const body = new URLSearchParams(init.body as string);
    // Exact string equality — not just "looks similar" — catches trailing
    // slashes, trimming, or accidental re-encoding.
    expect(body.get('redirect_uri')).toBe(redirectUriWithNoSurprises);
  });

  it('never sends more than one request per call, even on failure', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));

    await expect(exchangeCodeForTokens(env, 'auth-code-123', PROD_REDIRECT_URI)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws an IntuitOAuthError with the invalid_client code on an invalid_client response', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_client', error_description: 'Client authentication failed' }), { status: 401 })
    );

    const err = await exchangeCodeForTokens(env, 'auth-code-123', PROD_REDIRECT_URI).catch(e => e);
    expect(err).toBeInstanceOf(IntuitOAuthError);
    expect((err as IntuitOAuthError).errorCode).toBe('invalid_client');
    expect((err as IntuitOAuthError).status).toBe(401);
  });

  it('throws an IntuitOAuthError with the invalid_grant code on an invalid_grant response', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Authorization code expired' }), { status: 400 })
    );

    const err = await exchangeCodeForTokens(env, 'auth-code-123', PROD_REDIRECT_URI).catch(e => e);
    expect(err).toBeInstanceOf(IntuitOAuthError);
    expect((err as IntuitOAuthError).errorCode).toBe('invalid_grant');
    expect((err as IntuitOAuthError).status).toBe(400);
  });

  it('logs only safe diagnostic fields on failure — never secrets, code, or the Basic header', async () => {
    const env = createTestEnv({ INTUIT_CLIENT_ID: 'super-secret-client-id', INTUIT_CLIENT_SECRET: 'super-secret-client-secret' });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Authorization code expired' }), {
        status: 400,
        headers: { intuit_tid: 'abc-123-request-id' }
      })
    );

    await expect(exchangeCodeForTokens(env, 'top-secret-auth-code', PROD_REDIRECT_URI)).rejects.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedArgs = consoleErrorSpy.mock.calls.flat();
    const loggedText = JSON.stringify(loggedArgs);

    // Must be present: safe diagnostic fields.
    expect(loggedText).toContain('400');
    expect(loggedText).toContain('invalid_grant');
    expect(loggedText).toContain('Authorization code expired');
    expect(loggedText).toContain('abc-123-request-id');
    expect(loggedText).toContain(PROD_REDIRECT_URI);
    expect(loggedText).toMatch(/"hasClientId":true/);
    expect(loggedText).toMatch(/"hasClientSecret":true/);
    expect(loggedText).toContain('"clientIdLength":22'); // 'super-secret-client-id'.length
    expect(loggedText).toContain('"clientSecretLength":26'); // 'super-secret-client-secret'.length

    // Must never be present: actual secret values, the auth code, or the Basic header.
    expect(loggedText).not.toContain('super-secret-client-id');
    expect(loggedText).not.toContain('super-secret-client-secret');
    expect(loggedText).not.toContain('top-secret-auth-code');
    expect(loggedText).not.toContain('Basic ');
    expect(loggedText).not.toContain(btoa('super-secret-client-id:super-secret-client-secret'));
  });
});

describe('connectNewRealm (OAuth callback → encrypted D1 persistence)', () => {
  it('persists an encrypted token bundle to D1 on a successful exchange', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(successResponse());
    const realmId = `realm-${crypto.randomUUID()}`;

    await connectNewRealm(env, 'auth-code-123', realmId, PROD_REDIRECT_URI);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stored = await new TokenRepository(env).getConnection(realmId);
    expect(stored?.bundle.access_token).toBe('brand-new-access-token');
    expect(stored?.bundle.refresh_token).toBe('brand-new-refresh-token');
    expect(stored?.bundle.realm_id).toBe(realmId);

    // The raw D1 row must never hold the plaintext token — only ciphertext.
    const rawRow = await env.DB.prepare(`SELECT encrypted_token_bundle FROM qbo_connections WHERE realm_id = ?`)
      .bind(realmId)
      .first<{ encrypted_token_bundle: string }>();
    expect(rawRow?.encrypted_token_bundle).toBeTruthy();
    expect(rawRow?.encrypted_token_bundle).not.toContain('brand-new-access-token');
    expect(rawRow?.encrypted_token_bundle).not.toContain('brand-new-refresh-token');
  });

  it('does not persist anything to D1 when the exchange fails', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));
    const realmId = `realm-${crypto.randomUUID()}`;

    await expect(connectNewRealm(env, 'auth-code-123', realmId, PROD_REDIRECT_URI)).rejects.toThrow(IntuitOAuthError);

    const stored = await new TokenRepository(env).getConnection(realmId);
    expect(stored).toBeNull();
  });
});
