import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { createUser } from '../src/lib/users';
import { createSession, SESSION_COOKIE } from '../src/lib/session';
import { TokenRepository, type TokenBundle } from '../src/lib/tokenRepository';

async function signIn(env: ReturnType<typeof createTestEnv>) {
  const user = await createUser(env, 'staff@micasacarehomes.example', 'a-very-strong-password-123', 'staff');
  const { token } = await createSession(env, user.id);
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('token privacy in browser-facing responses', () => {
  it('returns 401 with no token data when there is no session', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request('https://test.example.com/api/qbo/status'), env);
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).not.toMatch(/access_token|refresh_token/i);
  });

  it('never includes token fields in /api/qbo/status, connected or not', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);

    const disconnectedRes = await app.fetch(new Request('https://test.example.com/api/qbo/status', { headers: { Cookie: cookie } }), env);
    const disconnectedBody = await disconnectedRes.json();
    expect(disconnectedBody).toEqual({ connected: false });

    const realmId = `realm-${crypto.randomUUID()}`;
    const now = Date.now();
    const bundle: TokenBundle = {
      access_token: 'super-secret-access-token',
      refresh_token: 'super-secret-refresh-token',
      token_type: 'bearer',
      access_token_expires_at: now + 3600_000,
      refresh_token_expires_at: now + 1000_000_000,
      realm_id: realmId
    };
    await new TokenRepository(env).upsertConnection(realmId, bundle);

    const connectedRes = await app.fetch(new Request('https://test.example.com/api/qbo/status', { headers: { Cookie: cookie } }), env);
    const rawBody = await connectedRes.text();
    expect(rawBody).not.toContain('super-secret-access-token');
    expect(rawBody).not.toContain('super-secret-refresh-token');
    expect(rawBody).not.toMatch(/access_token|refresh_token/i);

    const connectedJson = JSON.parse(rawBody);
    expect(connectedJson.connected).toBe(true);
    expect(connectedJson.realmId).toBe(realmId);
  });

  it('never exposes the encryption key or client secret through any response', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    const res = await app.fetch(new Request('https://test.example.com/api/qbo/status', { headers: { Cookie: cookie } }), env);
    const body = await res.text();
    expect(body).not.toContain(env.TOKEN_ENCRYPTION_KEY);
    expect(body).not.toContain(env.INTUIT_CLIENT_SECRET);
  });
});

describe('auth gate on QuickBooks routes', () => {
  it('rejects unauthenticated access to QuickBooks business routes', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request('https://test.example.com/api/qbo/overdue-summary', { method: 'POST' }), env);
    expect(res.status).toBe(401);
  });

  it('rejects unauthenticated access to the chat route', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request('https://test.example.com/api/chat', { method: 'POST', body: '{}' }), env);
    expect(res.status).toBe(401);
  });

  it('rejects non-admins from the admin routes', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env); // non-admin user
    const res = await app.fetch(new Request('https://test.example.com/api/admin/users', { headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(403);
  });
});

describe('login', () => {
  it('rejects an incorrect password without leaking whether the email exists', async () => {
    const env = createTestEnv();
    await createUser(env, 'staff2@micasacarehomes.example', 'correct-horse-battery-staple', 'staff');

    const res = await app.fetch(
      new Request('https://test.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'staff2@micasacarehomes.example', password: 'wrong-password' })
      }),
      env
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBeTruthy();
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('issues an HttpOnly, non-localStorage session cookie on success', async () => {
    const env = createTestEnv();
    await createUser(env, 'staff3@micasacarehomes.example', 'correct-horse-battery-staple', 'staff');

    const res = await app.fetch(
      new Request('https://test.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'staff3@micasacarehomes.example', password: 'correct-horse-battery-staple' })
      }),
      env
    );
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//i);
  });

  it('logs in with an email that differs only in case from the stored one', async () => {
    const env = createTestEnv();
    await createUser(env, 'CaseTest@MicasaCareHomes.example', 'correct-horse-battery-staple', 'staff');

    const res = await app.fetch(
      new Request('https://test.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'casetest@micasacarehomes.example', password: 'correct-horse-battery-staple' })
      }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated?: boolean; email?: string };
    expect(body.authenticated).toBe(true);
    expect(body.email).toBe('casetest@micasacarehomes.example');
  });

  it('marks the session cookie Secure over an https request', async () => {
    const env = createTestEnv();
    await createUser(env, 'secure-cookie@micasacarehomes.example', 'correct-horse-battery-staple', 'staff');

    const res = await app.fetch(
      new Request('https://test.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'secure-cookie@micasacarehomes.example', password: 'correct-horse-battery-staple' })
      }),
      env
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/Secure/i);
  });

  it('omits Secure on a plain http request (local dev)', async () => {
    const env = createTestEnv();
    await createUser(env, 'http-cookie@micasacarehomes.example', 'correct-horse-battery-staple', 'staff');

    const res = await app.fetch(
      new Request('http://localhost:8787/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'http-cookie@micasacarehomes.example', password: 'correct-horse-battery-staple' })
      }),
      env
    );
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it('still logs in and validates sessions when SESSION_SECRET is unset (not currently load-bearing)', async () => {
    const env = createTestEnv({ SESSION_SECRET: '' });
    await createUser(env, 'no-secret@micasacarehomes.example', 'correct-horse-battery-staple', 'staff');

    const loginRes = await app.fetch(
      new Request('https://test.example.com/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'no-secret@micasacarehomes.example', password: 'correct-horse-battery-staple' })
      }),
      env
    );
    expect(loginRes.status).toBe(200);

    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const cookieValue = setCookie.split(';')[0] ?? '';
    const sessionRes = await app.fetch(
      new Request('https://test.example.com/api/auth/session', { headers: { Cookie: cookieValue } }),
      env
    );
    const body = (await sessionRes.json()) as { authenticated?: boolean };
    expect(body.authenticated).toBe(true);
  });
});
