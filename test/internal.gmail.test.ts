// Gmail test-send verification (see docs/INTEGRATION_HEALTH.md in the CRM
// repo) — backs the CRM's Admin-only "Send test email" action on
// Integration Health. Never sends a real email in these tests: Gmail's
// OAuth token endpoint and the Gmail API send endpoint are both mocked via
// a stubbed global fetch, exactly like every other QuickBooks/Groq test in
// this suite.
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { signTestAssertion } from './helpers/signAssertion';
import { listAuditLog } from '../src/lib/auditLog';

const BASE = 'https://test.example.com/internal';

function req(path: string, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, init);
}

function token(secret: string, permissions: string[], sub = 'admin@example.com') {
  return signTestAssertion(secret, { sub, org: 'micasa', role: 'admin', permissions });
}

function mockGmailSuccess(messageId = 'msg-abc123') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'fake-access-token' }), { status: 200 });
      }
      if (url.includes('gmail.googleapis.com')) {
        return new Response(JSON.stringify({ id: messageId, threadId: 'thread-1' }), { status: 200 });
      }
      throw new Error(`Unexpected fetch to ${url}`);
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /internal/gmail/test-send', () => {
  it('is forbidden without finance.gmail.test', async () => {
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.connectionHealth.view']);
    const res = await app.fetch(
      req('/gmail/test-send', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientEmail: 'admin@example.com' }) }),
      env
    );
    expect(res.status).toBe(403);
  });

  it('rejects an invalid recipient email without ever calling Gmail', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.test']);
    const res = await app.fetch(
      req('/gmail/test-send', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientEmail: 'not-an-email' }) }),
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { success: boolean; errorCategory: string };
    expect(body.success).toBe(false);
    expect(body.errorCategory).toBe('invalid_recipient');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing recipient email', async () => {
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.test']);
    const res = await app.fetch(
      req('/gmail/test-send', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({}) }),
      env
    );
    expect(res.status).toBe(400);
  });

  it('returns 503 with errorCategory "not_configured" when Gmail credentials are missing, without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = createTestEnv({ GMAIL_CLIENT_ID: undefined, GMAIL_CLIENT_SECRET: undefined, GMAIL_REFRESH_TOKEN: undefined });
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.test']);
    const res = await app.fetch(
      req('/gmail/test-send', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientEmail: 'admin@example.com' }) }),
      env
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { success: boolean; errorCategory: string };
    expect(body.errorCategory).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the fixed test message, returns the real Gmail message id, and records a safe audit event (no token, no body)', async () => {
    mockGmailSuccess('msg-real-id-1');
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.test'], 'admin@micasacarehomes.example');
    const res = await app.fetch(
      req('/gmail/test-send', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientEmail: 'admin@micasacarehomes.example' }) }),
      env
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toMatch(/fake-access-token|access_token|refresh_token/i);
    const body = JSON.parse(raw) as { success: boolean; messageId: string | null };
    expect(body.success).toBe(true);
    expect(body.messageId).toBe('msg-real-id-1');

    const log = await listAuditLog(env, 10);
    const entry = log.find((e) => e.action === 'gmail_test_send_succeeded');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toMatch(/fake-access-token|This is a test message/);
  });

  it('returns 502 with errorCategory "send_failed" when the Gmail API rejects the send, and records a failure audit event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'fake-access-token' }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 429 });
      })
    );
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.test']);
    const res = await app.fetch(
      req('/gmail/test-send', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientEmail: 'admin@example.com' }) }),
      env
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { success: boolean; errorCategory: string };
    expect(body.success).toBe(false);
    expect(body.errorCategory).toBe('send_failed');

    const log = await listAuditLog(env, 10);
    expect(log.some((e) => e.action === 'gmail_test_send_failed')).toBe(true);
  });

  it('returns 502 with errorCategory "auth_failed" when the Gmail token refresh itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.test']);
    const res = await app.fetch(
      req('/gmail/test-send', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ recipientEmail: 'admin@example.com' }) }),
      env
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { errorCategory: string };
    expect(body.errorCategory).toBe('auth_failed');
  });
});

describe('POST /internal/gmail/signing-link', () => {
  const validBody = { recipientEmail: 'signer@example.com', signerName: 'Jordan Signer', documentTitle: 'Offer Letter', signingUrl: 'https://mi-casa-crm.elijahkrumme.workers.dev/sign.html?token=abc123', expiresAtLabel: 'in 14 days' };

  it('is forbidden without finance.gmail.signingLink', async () => {
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.test']);
    const res = await app.fetch(
      req('/gmail/signing-link', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify(validBody) }),
      env
    );
    expect(res.status).toBe(403);
  });

  it('rejects an invalid recipient email without ever calling Gmail', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.signingLink']);
    const res = await app.fetch(
      req('/gmail/signing-link', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...validBody, recipientEmail: 'not-an-email' }) }),
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCategory: string };
    expect(body.errorCategory).toBe('invalid_recipient');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a signing URL that is not https', async () => {
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.signingLink']);
    const res = await app.fetch(
      req('/gmail/signing-link', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...validBody, signingUrl: 'http://insecure.example/sign' }) }),
      env
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errorCategory: string };
    expect(body.errorCategory).toBe('invalid_signing_url');
  });

  it('returns 503 not_configured without calling fetch when Gmail credentials are missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const env = createTestEnv({ GMAIL_CLIENT_ID: undefined, GMAIL_CLIENT_SECRET: undefined, GMAIL_REFRESH_TOKEN: undefined });
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.signingLink']);
    const res = await app.fetch(
      req('/gmail/signing-link', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify(validBody) }),
      env
    );
    expect(res.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends a real signing-link email, includes the URL in the body, and records a safe audit event', async () => {
    let capturedBody: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'fake-access-token' }), { status: 200 });
        if (url.includes('gmail.googleapis.com')) {
          capturedBody = init?.body ? String(init.body) : null;
          return new Response(JSON.stringify({ id: 'msg-signing-1', threadId: 't1' }), { status: 200 });
        }
        throw new Error(`Unexpected fetch to ${url}`);
      })
    );
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.signingLink']);
    const res = await app.fetch(
      req('/gmail/signing-link', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify(validBody) }),
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; messageId: string };
    expect(body.success).toBe(true);
    expect(body.messageId).toBe('msg-signing-1');
    expect(capturedBody).toBeTruthy();
    // The raw Gmail send request base64-encodes the message; decode enough
    // to confirm the real signing URL/title made it into the actual email
    // body, not just the response.
    const raw = JSON.parse(capturedBody!) as { raw: string };
    const decoded = atob(raw.raw.replace(/-/g, '+').replace(/_/g, '/'));
    expect(decoded).toContain(validBody.signingUrl);
    expect(decoded).toContain('Offer Letter');

    const log = await listAuditLog(env, 10);
    const entry = log.find((e) => e.action === 'gmail_signing_link_sent');
    expect(entry).toBeTruthy();
    expect(JSON.stringify(entry)).not.toMatch(/signer@example\.com|token=abc123/);
  });

  it('returns 502 send_failed when the Gmail API rejects the send, and records a failure audit event', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'fake-access-token' }), { status: 200 });
        return new Response(JSON.stringify({ error: 'quota exceeded' }), { status: 429 });
      })
    );
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.signingLink']);
    const res = await app.fetch(
      req('/gmail/signing-link', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify(validBody) }),
      env
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { errorCategory: string };
    expect(body.errorCategory).toBe('send_failed');
    const log = await listAuditLog(env, 10);
    expect(log.some((e) => e.action === 'gmail_signing_link_failed')).toBe(true);
  });

  it('a reminder send uses a distinct subject line and is flagged in the audit event', async () => {
    let capturedBody: string | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'fake-access-token' }), { status: 200 });
        if (url.includes('gmail.googleapis.com')) {
          capturedBody = init?.body ? String(init.body) : null;
          return new Response(JSON.stringify({ id: 'msg-reminder-1' }), { status: 200 });
        }
        throw new Error(`Unexpected fetch to ${url}`);
      })
    );
    const env = createTestEnv();
    const t = await token(env.FINANCE_INTERNAL_SECRET!, ['finance.gmail.signingLink']);
    await app.fetch(
      req('/gmail/signing-link', { method: 'POST', headers: { 'X-Service-Assertion': t, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...validBody, reminder: true }) }),
      env
    );
    const raw = JSON.parse(capturedBody!) as { raw: string };
    const decoded = atob(raw.raw.replace(/-/g, '+').replace(/_/g, '/'));
    expect(decoded).toContain('Reminder:');

    const log = await listAuditLog(env, 10);
    const entry = log.find((e) => e.action === 'gmail_signing_link_sent');
    expect((entry as unknown as { metadata_json?: string })?.metadata_json || JSON.stringify(entry)).toContain('"reminder":true');
  });
});
