// The CRM-initiated OAuth callback (routeCrmInitiatedCallback in
// src/routes/qbo.ts) is the one route in this service reachable by a
// third party (Intuit) with no application session of any kind — these
// tests focus on the adversarial cases (missing/unknown/expired/reused
// state, failed exchange) as much as the happy path, and explicitly assert
// that no secret ever appears in a log line or a browser-visible response.
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { signTestAssertion } from './helpers/signAssertion';
import { createOAuthState } from '../src/lib/oauthState';
import { TokenRepository } from '../src/lib/tokenRepository';

const BASE = 'https://test.example.com';

function req(path: string, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, init);
}

function testEnvWithCrm() {
  return createTestEnv({ CRM_BASE_URL: 'https://crm.test.example.com' });
}

async function mintServiceAssertion(env: ReturnType<typeof createTestEnv>, permissions: string[]) {
  return signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
    sub: 'admin@example.com',
    org: 'micasa',
    role: 'admin',
    permissions
  });
}

async function mintCrmInitiatedState(env: ReturnType<typeof createTestEnv>, userSub = 'admin@example.com') {
  return createOAuthState(env, `svc:${userSub}`);
}

const FAKE_TOKEN_RESPONSE = {
  access_token: 'fake-access-token-value',
  refresh_token: 'fake-refresh-token-value',
  token_type: 'bearer',
  expires_in: 3600,
  x_refresh_token_expires_in: 8640000
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockIntuitTokenExchange(response: { ok: boolean; body: unknown; status?: number }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(response.body), { status: response.status ?? (response.ok ? 200 : 400) }))
  );
}

describe('GET /api/qbo/callback — CRM-initiated flow (no QuickBooks staff session)', () => {
  it('works without any staff session cookie, stores the connection, and redirects to CRM Finance with no secrets in the URL', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    mockIntuitTokenExchange({ ok: true, body: FAKE_TOKEN_RESPONSE });

    const res = await app.fetch(
      req(`/api/qbo/callback?state=${state}&code=fake-auth-code-xyz&realmId=123456`, { redirect: 'manual' }),
      env
    );

    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toBe('https://crm.test.example.com/finance.html?qbo=connected');
    // Never a token, code, or secret in the redirect URL.
    expect(location).not.toMatch(/fake-access-token|fake-refresh-token|fake-auth-code/);

    const repo = new TokenRepository(env);
    const realmId = await repo.getActiveRealmId();
    expect(realmId).toBe('123456');
    const connection = await repo.getConnection(realmId!);
    expect(connection?.bundle.access_token).toBe('fake-access-token-value'); // decrypted read-back proves it was actually stored, not faked
  });

  it('never requires a QuickBooks Companion staff session — no cookie is sent at all in this test, and it still succeeds', async () => {
    // Deliberately no Cookie header anywhere in this suite — proves the
    // CRM-initiated branch never depends on one.
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    mockIntuitTokenExchange({ ok: true, body: FAKE_TOKEN_RESPONSE });
    const res = await app.fetch(req(`/api/qbo/callback?state=${state}&code=abc&realmId=999`, { redirect: 'manual' }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('qbo=connected');
  });

  it('rejects a request with no state parameter at all — falls through to the staff flow, which 401s with no session', async () => {
    const env = testEnvWithCrm();
    const res = await app.fetch(req('/api/qbo/callback?code=abc&realmId=999', { redirect: 'manual' }), env);
    expect(res.status).toBe(401);
  });

  it('rejects an unknown/never-minted state', async () => {
    const env = testEnvWithCrm();
    const res = await app.fetch(req('/api/qbo/callback?state=not-a-real-state&code=abc&realmId=999', { redirect: 'manual' }), env);
    // Not found as svc:-prefixed -> falls through -> no staff session -> 401.
    expect(res.status).toBe(401);
  });

  it('rejects an expired state', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    // Force it into the past.
    await env.DB.prepare(`UPDATE oauth_state SET expires_at = ? WHERE state = ?`).bind(Date.now() - 1000, state).run();

    const res = await app.fetch(req(`/api/qbo/callback?state=${state}&code=abc&realmId=999`, { redirect: 'manual' }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=state_expired');
  });

  it('rejects a reused (already-consumed) state — single-use enforcement', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    mockIntuitTokenExchange({ ok: true, body: FAKE_TOKEN_RESPONSE });

    const first = await app.fetch(req(`/api/qbo/callback?state=${state}&code=abc&realmId=999`, { redirect: 'manual' }), env);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toContain('qbo=connected');

    const second = await app.fetch(req(`/api/qbo/callback?state=${state}&code=abc&realmId=999`, { redirect: 'manual' }), env);
    expect(second.status).toBe(302);
    expect(second.headers.get('location')).toContain('reason=state_reused');
  });

  it('rejects a missing authorization code', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    const res = await app.fetch(req(`/api/qbo/callback?state=${state}&realmId=999`, { redirect: 'manual' }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=missing_params');
  });

  it('rejects a missing realmId', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    const res = await app.fetch(req(`/api/qbo/callback?state=${state}&code=abc`, { redirect: 'manual' }), env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('reason=missing_params');
  });

  it('handles a token-exchange failure safely — redirects with a safe reason code, never the raw Intuit error body, and stores nothing', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    mockIntuitTokenExchange({ ok: false, status: 400, body: { error: 'invalid_grant', error_description: 'This authorization code has expired secret-detail-xyz' } });

    const res = await app.fetch(req(`/api/qbo/callback?state=${state}&code=abc&realmId=999`, { redirect: 'manual' }), env);
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain('reason=exchange_failed');
    expect(location).not.toMatch(/secret-detail-xyz|invalid_grant/);

    const repo = new TokenRepository(env);
    expect(await repo.getActiveRealmId()).toBeNull();
  });

  it('falls through to the staff flow (401, no session) rather than trusting a state minted for a different flow entirely', async () => {
    // A state whose user_id does NOT start with 'svc:' (i.e. an ordinary
    // staff-flow state) must never be handled by the CRM-initiated branch.
    const env = testEnvWithCrm();
    const state = await createOAuthState(env, 'staff-user-id-123');
    const res = await app.fetch(req(`/api/qbo/callback?state=${state}&code=abc&realmId=999`, { redirect: 'manual' }), env);
    expect(res.status).toBe(401);
  });

  it('ignores any attempt to override the return destination via a query parameter — only server-side CRM_BASE_URL decides where to redirect', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    mockIntuitTokenExchange({ ok: true, body: FAKE_TOKEN_RESPONSE });

    const res = await app.fetch(
      req(`/api/qbo/callback?state=${state}&code=abc&realmId=999&returnUrl=https://evil.example.com&redirect_uri=https://evil.example.com`, { redirect: 'manual' }),
      env
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://crm.test.example.com/finance.html?qbo=connected');
  });

  it('logs safe diagnostics only — never the authorization code, access token, or refresh token', async () => {
    const env = testEnvWithCrm();
    const state = await mintCrmInitiatedState(env);
    mockIntuitTokenExchange({ ok: true, body: FAKE_TOKEN_RESPONSE });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await app.fetch(req(`/api/qbo/callback?state=${state}&code=super-secret-auth-code&realmId=999`, { redirect: 'manual' }), env);

    const allLoggedText = [...logSpy.mock.calls, ...errorSpy.mock.calls].map(args => JSON.stringify(args)).join('\n');
    expect(allLoggedText).not.toMatch(/super-secret-auth-code|fake-access-token-value|fake-refresh-token-value/);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('POST /internal/oauth/authorize-url — only an admin with finance.oauth.connect can initiate', () => {
  it('rejects a caller without finance.oauth.connect', async () => {
    const env = testEnvWithCrm();
    const token = await mintServiceAssertion(env, ['finance.customers.view']);
    const res = await app.fetch(req('/internal/oauth/authorize-url', { method: 'POST', headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(403);
  });

  it('accepts a caller with finance.oauth.connect and mints a real svc:-prefixed state', async () => {
    const env = testEnvWithCrm();
    const token = await mintServiceAssertion(env, ['finance.oauth.connect']);
    const res = await app.fetch(req('/internal/oauth/authorize-url', { method: 'POST', headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; url: string };
    expect(body.status).toBe('ok');
    const state = new URL(body.url).searchParams.get('state')!;
    const row = await env.DB.prepare(`SELECT user_id FROM oauth_state WHERE state = ?`).bind(state).first<{ user_id: string }>();
    expect(row?.user_id).toBe('svc:admin@example.com');
  });

  it('reports not_configured (never a fake URL) when Intuit credentials are unset', async () => {
    const env = testEnvWithCrm();
    env.INTUIT_CLIENT_ID = '';
    const token = await mintServiceAssertion(env, ['finance.oauth.connect']);
    const res = await app.fetch(req('/internal/oauth/authorize-url', { method: 'POST', headers: { 'X-Service-Assertion': token } }), env);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('not_configured');
  });
});
