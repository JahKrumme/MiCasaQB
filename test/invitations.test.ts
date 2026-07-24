import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv } from './helpers/testEnv';
import app from '../src/index';
import { createUser } from '../src/lib/users';
import { createSession, SESSION_COOKIE } from '../src/lib/session';
import { acceptInvitation, createOrRefreshInvitation } from '../src/lib/invitations';
import { sha256Hex } from '../src/lib/crypto';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockGmailSuccess() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'fake-gmail-access-token' }), { status: 200 });
    }
    if (url.includes('gmail.googleapis.com')) {
      return new Response(JSON.stringify({ id: 'fake-message-id' }), { status: 200 });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

async function signInAsAdmin(env: ReturnType<typeof createTestEnv>) {
  const admin = await createUser(env, 'boss@micasacarehomes.example', 'a-very-strong-password-123', 'admin');
  const { token } = await createSession(env, admin.id);
  return { admin, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('admin invite creation', () => {
  it('lets an admin invite a new user by email and role, and records it in the audit log', async () => {
    const env = createTestEnv();
    const { cookie } = await signInAsAdmin(env);
    mockGmailSuccess();

    const res = await app.fetch(
      new Request('https://test.example.com/api/admin/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ email: 'new-hire@micasacarehomes.example', role: 'staff' })
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; emailSent: boolean };
    expect(body.success).toBe(true);
    expect(body.emailSent).toBe(true);

    const listRes = await app.fetch(new Request('https://test.example.com/api/admin/users', { headers: { Cookie: cookie } }), env);
    const listBody = (await listRes.json()) as { invitations: { email: string; role: string; status: string }[] };
    expect(listBody.invitations).toContainEqual(
      expect.objectContaining({ email: 'new-hire@micasacarehomes.example', role: 'staff', status: 'pending' })
    );

    const auditRes = await app.fetch(new Request('https://test.example.com/api/admin/audit-log', { headers: { Cookie: cookie } }), env);
    const auditBody = (await auditRes.json()) as { entries: { action: string; target: string | null }[] };
    expect(auditBody.entries).toContainEqual(expect.objectContaining({ action: 'user_invited', target: 'new-hire@micasacarehomes.example' }));
  });

  it('rejects invitations from non-admin users', async () => {
    const env = createTestEnv();
    const staff = await createUser(env, 'staff@micasacarehomes.example', 'a-very-strong-password-123', 'staff');
    const { token } = await createSession(env, staff.id);

    const res = await app.fetch(
      new Request('https://test.example.com/api/admin/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE}=${token}` },
        body: JSON.stringify({ email: 'someone@micasacarehomes.example', role: 'staff' })
      }),
      env
    );
    expect(res.status).toBe(403);
  });
});

describe('admin send-test-email', () => {
  it('sends a test email to the requesting admin and rejects non-admins', async () => {
    const env = createTestEnv();
    mockGmailSuccess();
    const { cookie } = await signInAsAdmin(env);

    const res = await app.fetch(new Request('https://test.example.com/api/admin/send-test-email', { method: 'POST', headers: { Cookie: cookie } }), env);
    expect(res.status).toBe(200);

    const staff = await createUser(env, 'staff-cant-test-email@micasacarehomes.example', 'a-very-strong-password-123', 'staff');
    const { token } = await createSession(env, staff.id);
    const staffRes = await app.fetch(
      new Request('https://test.example.com/api/admin/send-test-email', { method: 'POST', headers: { Cookie: `${SESSION_COOKIE}=${token}` } }),
      env
    );
    expect(staffRes.status).toBe(403);
  });
});

describe('invitation acceptance', () => {
  it('rejects an expired invitation', async () => {
    const env = createTestEnv();
    const rawToken = 'expired-test-token-1234567890';
    const tokenHash = await sha256Hex(rawToken);
    const now = Date.now();

    await env.DB.prepare(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    )
      .bind(crypto.randomUUID(), 'expired-invitee@micasacarehomes.example', 'staff', tokenHash, 'someone', now - 50 * 60 * 60 * 1000, now - 2 * 60 * 60 * 1000)
      .run();

    const result = await acceptInvitation(env, rawToken, 'a-strong-new-password-123');
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a reused invitation on the second acceptance attempt', async () => {
    const env = createTestEnv();
    mockGmailSuccess();
    const { admin } = await signInAsAdmin(env);

    const { inviteUrl } = await createOrRefreshInvitation(env, {
      email: 'one-time@micasacarehomes.example',
      role: 'staff',
      invitedByUserId: admin.id,
      baseUrl: 'https://test.example.com'
    });
    const rawToken = new URL(inviteUrl).searchParams.get('token')!;

    const first = await acceptInvitation(env, rawToken, 'a-strong-new-password-123');
    expect(first.ok).toBe(true);

    const second = await acceptInvitation(env, rawToken, 'a-different-password-456');
    expect(second).toEqual({ ok: false, reason: 'used' });
  });

  it('lets an invited user set a password and signs them in immediately (full HTTP round trip)', async () => {
    const env = createTestEnv();
    mockGmailSuccess();
    const { admin } = await signInAsAdmin(env);

    const { inviteUrl } = await createOrRefreshInvitation(env, {
      email: 'brand-new@micasacarehomes.example',
      role: 'read_only',
      invitedByUserId: admin.id,
      baseUrl: 'https://test.example.com'
    });
    const rawToken = new URL(inviteUrl).searchParams.get('token')!;

    const res = await app.fetch(
      new Request(`https://test.example.com/api/invitations/${rawToken}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'a-brand-new-password-123', confirmPassword: 'a-brand-new-password-123' })
      }),
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated: boolean; email: string; role: string };
    expect(body.authenticated).toBe(true);
    expect(body.email).toBe('brand-new@micasacarehomes.example');
    expect(body.role).toBe('read_only');
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');
  });
});
