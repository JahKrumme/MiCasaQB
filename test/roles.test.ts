import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv } from './helpers/testEnv';
import app from '../src/index';
import { createUser, setUserDisabled } from '../src/lib/users';
import { createSession, SESSION_COOKIE } from '../src/lib/session';
import { TokenRepository, type TokenBundle } from '../src/lib/tokenRepository';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // The role gate must reject writes/admin-routes before any QuickBooks API
  // call is made, but a couple of tests confirm read endpoints DO get past
  // the gate — those need a QBO API response to not hang/hit the network.
  fetchMock = vi.fn(async (url: string) => {
    if (url.includes('quickbooks.api.intuit.com')) {
      return new Response(JSON.stringify({ QueryResponse: {} }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function signIn(env: ReturnType<typeof createTestEnv>, email: string, role: 'admin' | 'staff' | 'read_only') {
  const user = await createUser(env, email, 'a-very-strong-password-123', role);
  const { token } = await createSession(env, user.id);
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

function freshBundle(realmId: string): TokenBundle {
  const now = Date.now();
  return {
    access_token: 'org-level-access-token',
    refresh_token: 'org-level-refresh-token',
    token_type: 'bearer',
    access_token_expires_at: now + 60 * 60 * 1000,
    refresh_token_expires_at: now + 100 * 24 * 60 * 60 * 1000,
    realm_id: realmId
  };
}

describe('role-based access', () => {
  it('blocks staff and read-only users from admin routes', async () => {
    const env = createTestEnv();
    const { cookie: staffCookie } = await signIn(env, 'staff@micasacarehomes.example', 'staff');
    const { cookie: readOnlyCookie } = await signIn(env, 'viewer@micasacarehomes.example', 'read_only');

    const staffRes = await app.fetch(new Request('https://test.example.com/api/admin/users', { headers: { Cookie: staffCookie } }), env);
    expect(staffRes.status).toBe(403);

    const readOnlyRes = await app.fetch(new Request('https://test.example.com/api/admin/users', { headers: { Cookie: readOnlyCookie } }), env);
    expect(readOnlyRes.status).toBe(403);
  });

  it('blocks a read-only user from write operations (create-resident) but allows read operations (overdue-summary)', async () => {
    const env = createTestEnv();
    const realmId = `realm-${crypto.randomUUID()}`;
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));
    const { cookie } = await signIn(env, 'viewer@micasacarehomes.example', 'read_only');

    const writeRes = await app.fetch(
      new Request('https://test.example.com/api/qbo/create-resident', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Someone', paymentType: 'Private Pay', monthlyRate: 1000, moveInDate: '2026-01-01' })
      }),
      env
    );
    expect(writeRes.status).toBe(403);

    // Sanity check the same account isn't blocked outright — read endpoints stay reachable.
    // (overdue-summary calls out to the QBO API, which isn't mocked here, so we only assert
    // it gets past the role gate — i.e. never a 403 — not that the QBO call itself succeeds.)
    const readRes = await app.fetch(
      new Request('https://test.example.com/api/qbo/overdue-summary', { method: 'POST', headers: { Cookie: cookie } }),
      env
    );
    expect(readRes.status).not.toBe(403);
  });

  it('lets staff perform write operations that read-only cannot', async () => {
    const env = createTestEnv();
    const realmId = `realm-${crypto.randomUUID()}`;
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));
    const { cookie } = await signIn(env, 'staffer@micasacarehomes.example', 'staff');

    const res = await app.fetch(
      new Request('https://test.example.com/api/qbo/create-resident', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ name: 'Someone', paymentType: 'Private Pay', monthlyRate: 1000, moveInDate: '2026-01-01' })
      }),
      env
    );
    expect(res.status).not.toBe(403);
  });
});

describe('organization-level QuickBooks connection', () => {
  it('a brand-new user can immediately use the existing QuickBooks connection without connecting it themselves', async () => {
    const env = createTestEnv();
    const realmId = `realm-${crypto.randomUUID()}`;
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));

    // The connection was never touched by this user — it pre-dates their account entirely.
    const { cookie } = await signIn(env, 'day-one-new-hire@micasacarehomes.example', 'staff');

    const res = await app.fetch(new Request('https://test.example.com/api/qbo/status', { headers: { Cookie: cookie } }), env);
    const body = (await res.json()) as { connected: boolean; realmId?: string };
    expect(body.connected).toBe(true);
    expect(body.realmId).toBe(realmId);
  });

  it('rejects non-admins from disconnecting QuickBooks', async () => {
    const env = createTestEnv();
    const realmId = `realm-${crypto.randomUUID()}`;
    await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));
    const { cookie: staffCookie } = await signIn(env, 'staffer@micasacarehomes.example', 'staff');
    const { cookie: readOnlyCookie } = await signIn(env, 'viewer@micasacarehomes.example', 'read_only');

    const staffRes = await app.fetch(new Request('https://test.example.com/api/qbo/disconnect', { method: 'POST', headers: { Cookie: staffCookie } }), env);
    expect(staffRes.status).toBe(403);

    const readOnlyRes = await app.fetch(
      new Request('https://test.example.com/api/qbo/disconnect', { method: 'POST', headers: { Cookie: readOnlyCookie } }),
      env
    );
    expect(readOnlyRes.status).toBe(403);

    // Confirm it's genuinely still connected — neither non-admin attempt tore it down.
    const stillConnected = await new TokenRepository(env).getConnection(realmId);
    expect(stillConnected).not.toBeNull();
  });

  it('rejects non-admins from initiating a new QuickBooks connection', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env, 'staffer@micasacarehomes.example', 'staff');
    const res = await app.fetch(new Request('https://test.example.com/api/qbo/connect', { headers: { Cookie: cookie }, redirect: 'manual' }), env);
    expect(res.status).toBe(403);
  });
});

describe('disabled accounts', () => {
  it('cannot log in even with the correct password', async () => {
    const env = createTestEnv();
    const user = await createUser(env, 'soon-disabled@micasacarehomes.example', 'a-very-strong-password-123', 'staff');
    await setUserDisabled(env, user.id, true);

    const res = await app.fetch(
      new Request('https://test.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'soon-disabled@micasacarehomes.example', password: 'a-very-strong-password-123' })
      }),
      env
    );
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('revokes existing sessions immediately when an account is disabled', async () => {
    const env = createTestEnv();
    const { user, cookie } = await signIn(env, 'active-then-disabled@micasacarehomes.example', 'staff');

    const beforeRes = await app.fetch(new Request('https://test.example.com/api/auth/whoami', { headers: { Cookie: cookie } }), env);
    expect(beforeRes.status).toBe(200);

    await setUserDisabled(env, user.id, true);

    const afterRes = await app.fetch(new Request('https://test.example.com/api/auth/whoami', { headers: { Cookie: cookie } }), env);
    expect(afterRes.status).toBe(401);
  });
});
