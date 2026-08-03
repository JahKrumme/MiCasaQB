// Regression coverage for the Daily Overdue Check scheduled job
// (.github/workflows/daily-check.yml -> POST /api/cron/overdue-check).
// Root cause of the production 500s this fixed: an uncaught Gmail failure
// (token refresh or send) inside runOverdueCheck() propagated straight
// through Hono's generic onError handler, which returns a bare
// {"error":"Internal server error"} and records nothing anywhere. Every
// test below drives that exact path — a real QuickBooks connection/query,
// mocked Gmail (never a real send), and verifies the response is now a
// typed, categorized result with a matching audit-log entry, never an
// unhandled 500.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { TokenRepository, type TokenBundle } from '../src/lib/tokenRepository';
import { listAuditLog } from '../src/lib/auditLog';
import { signTestAssertion } from './helpers/signAssertion';

const BASE = 'https://test.example.com';
const QBO_API = 'https://sandbox-quickbooks.api.intuit.com';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function freshBundle(realmId: string): TokenBundle {
  const now = Date.now();
  return {
    access_token: 'qb-access-token',
    refresh_token: 'qb-refresh-token',
    token_type: 'bearer',
    access_token_expires_at: now + 60 * 60 * 1000,
    refresh_token_expires_at: now + 100 * 24 * 60 * 60 * 1000,
    realm_id: realmId
  };
}

async function connectRealm(env: ReturnType<typeof createTestEnv>, realmId = 'realm-1') {
  await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));
  return realmId;
}

function overdueInvoice(overrides: Record<string, unknown> = {}) {
  return { DocNumber: '1001', CustomerRef: { name: 'Test Customer' }, DueDate: '2026-07-01', Balance: '150.00', ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubQboAndGmail(opts: {
  invoices?: Record<string, unknown>[];
  gmailTokenStatus?: number;
  gmailSendStatus?: number;
}) {
  const invoices = opts.invoices ?? [];
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith(QBO_API)) {
      return new Response(JSON.stringify({ QueryResponse: { Invoice: invoices } }), { status: 200 });
    }
    if (url === GMAIL_TOKEN_URL) {
      const status = opts.gmailTokenStatus ?? 200;
      return status === 200
        ? new Response(JSON.stringify({ access_token: 'fake-gmail-access-token' }), { status: 200 })
        : new Response('unauthorized', { status });
    }
    if (url === GMAIL_SEND_URL) {
      const status = opts.gmailSendStatus ?? 200;
      return status === 200
        ? new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 })
        : new Response(JSON.stringify({ error: 'quota exceeded' }), { status });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/cron/overdue-check — auth', () => {
  it('rejects a missing X-Cron-Secret', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST' }), env);
    expect(res.status).toBe(401);
  });

  it('rejects the wrong X-Cron-Secret', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': 'wrong' } }), env);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/cron/overdue-check — no QuickBooks connection', () => {
  it('returns 503 no-token without ever touching Gmail', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('no-token');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/cron/overdue-check — successful run', () => {
  it('reports no invoices without ever calling Gmail, and records a success audit event', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [] });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number; runId: string };
    expect(body.status).toBe('ok');
    expect(body.count).toBe(0);
    expect(body.runId).toBeTruthy();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('gmail'))).toBe(false);

    const log = await listAuditLog(env, 10);
    const entry = log.find(e => e.action === 'scheduled_overdue_check_succeeded');
    expect(entry).toBeTruthy();
    expect(entry!.metadata).toMatchObject({ reminderCount: 0, runId: body.runId });
  });

  it('sends the digest email once for multiple overdue invoices and records the real reminder count', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice(), overdueInvoice({ DocNumber: '1002', Balance: '75.50' })] });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number; total: number; runId: string };
    expect(body.status).toBe('ok');
    expect(body.count).toBe(2);
    expect(body.total).toBeCloseTo(225.5);

    const sendCalls = fetchMock.mock.calls.filter(([url]) => String(url) === GMAIL_SEND_URL);
    expect(sendCalls).toHaveLength(1);

    const log = await listAuditLog(env, 10);
    const entry = log.find(e => e.action === 'scheduled_overdue_check_succeeded');
    expect(entry!.metadata).toMatchObject({ reminderCount: 2 });
    // Never a customer name, invoice number, or dollar amount in the audit trail.
    expect(JSON.stringify(entry)).not.toMatch(/Test Customer|1001|150\.00/);
  });
});

describe('POST /api/cron/overdue-check — Gmail failures no longer produce an unhandled 500', () => {
  it('returns 503 not_configured and never calls fetch at all when Gmail credentials are missing', async () => {
    const env = createTestEnv({ GMAIL_CLIENT_ID: undefined, GMAIL_CLIENT_SECRET: undefined, GMAIL_REFRESH_TOKEN: undefined });
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()] });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; errorCategory: string };
    expect(body.status).toBe('gmail-error');
    expect(body.errorCategory).toBe('not_configured');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('gmail') || String(url).includes('googleapis'))).toBe(false);

    const log = await listAuditLog(env, 10);
    expect(log.some(e => e.action === 'scheduled_overdue_check_failed' && (e.metadata as { errorCategory?: string })?.errorCategory === 'not_configured')).toBe(true);
  });

  it('returns 502 auth_failed (not a bare 500) when the Gmail token refresh fails, and never attempts a send', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()], gmailTokenStatus: 401 });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string; errorCategory: string; runId: string };
    expect(body.status).toBe('gmail-error');
    expect(body.errorCategory).toBe('auth_failed');

    const sendCalls = fetchMock.mock.calls.filter(([url]) => String(url) === GMAIL_SEND_URL);
    expect(sendCalls).toHaveLength(0);

    const log = await listAuditLog(env, 10);
    const entry = log.find(e => e.action === 'scheduled_overdue_check_failed');
    expect(entry).toBeTruthy();
    expect(entry!.metadata).toMatchObject({ errorCategory: 'auth_failed', reminderCount: 1, runId: body.runId });
    expect(JSON.stringify(entry)).not.toMatch(/fake-gmail-access-token|Test Customer/);
  });

  it('returns 502 send_failed (not a bare 500) when Gmail rejects the send', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()], gmailSendStatus: 429 });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { status: string; errorCategory: string };
    expect(body.errorCategory).toBe('send_failed');

    const log = await listAuditLog(env, 10);
    expect(log.some(e => e.action === 'scheduled_overdue_check_failed' && (e.metadata as { errorCategory?: string })?.errorCategory === 'send_failed')).toBe(true);
  });

  it('the response body is always valid, categorized JSON — never the raw "Internal server error" fallback', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()], gmailTokenStatus: 401 });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    const raw = await res.text();
    expect(raw).not.toContain('Internal server error');
  });
});

describe('POST /api/cron/overdue-check?dryRun=true — safe production verification', () => {
  it('computes the real invoice count and total, verifies Gmail auth via a token-refresh-only call, never calls the actual send endpoint, and records no audit event', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice(), overdueInvoice({ DocNumber: '1002' })] });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check?dryRun=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number; dryRun: boolean; gmailAuthOk: boolean };
    expect(body.status).toBe('ok');
    expect(body.count).toBe(2);
    expect(body.dryRun).toBe(true);
    expect(body.gmailAuthOk).toBe(true);
    // The token-refresh check is real and expected — only the actual
    // message-send endpoint must never be called in dry-run mode.
    expect(fetchMock.mock.calls.some(([url]) => String(url) === GMAIL_SEND_URL)).toBe(false);

    const log = await listAuditLog(env, 10);
    expect(log.some(e => e.action === 'scheduled_overdue_check_succeeded' || e.action === 'scheduled_overdue_check_failed')).toBe(false);
  });

  it('a dry run still safely reports zero invoices, still checks Gmail auth, and records no audit event', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [] });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check?dryRun=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; dryRun: boolean; gmailAuthOk: boolean };
    expect(body.count).toBe(0);
    expect(body.dryRun).toBe(true);
    expect(body.gmailAuthOk).toBe(true);
    const log = await listAuditLog(env, 10);
    expect(log.some(e => e.action === 'scheduled_overdue_check_succeeded')).toBe(false);
  });

  it('a dry run still succeeds (200, real invoice count) even when Gmail credentials are missing, but reports gmailAuthOk: false with a safe category', async () => {
    const env = createTestEnv({ GMAIL_CLIENT_ID: undefined, GMAIL_CLIENT_SECRET: undefined, GMAIL_REFRESH_TOKEN: undefined });
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()] });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check?dryRun=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; count: number; gmailAuthOk: boolean; gmailAuthErrorCategory: string };
    expect(body.status).toBe('ok');
    expect(body.count).toBe(1);
    expect(body.gmailAuthOk).toBe(false);
    expect(body.gmailAuthErrorCategory).toBe('not_configured');
  });

  it('a dry run reports gmailAuthOk: false with "auth_failed" when the Gmail refresh token itself is rejected — the real signal for "would today\'s real run actually fail"', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()], gmailTokenStatus: 401 });
    const res = await app.fetch(new Request(`${BASE}/api/cron/overdue-check?dryRun=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { gmailAuthOk: boolean; gmailAuthErrorCategory: string };
    expect(body.gmailAuthOk).toBe(false);
    expect(body.gmailAuthErrorCategory).toBe('auth_failed');
    expect(fetchMock.mock.calls.some(([url]) => String(url) === GMAIL_SEND_URL)).toBe(false);
  });
});

describe('GET /internal/health/detailed — surfaces the last scheduled-run outcome', () => {
  function serviceToken(secret: string) {
    return signTestAssertion(secret, { sub: 'system', org: 'micasa', role: 'admin', permissions: ['finance.connectionHealth.view'] });
  }

  it('reports null when no scheduled run has ever completed', async () => {
    const env = createTestEnv();
    const t = await serviceToken(env.FINANCE_INTERNAL_SECRET!);
    const res = await app.fetch(new Request(`${BASE}/internal/health/detailed`, { headers: { 'X-Service-Assertion': t } }), env);
    const body = (await res.json()) as { lastOverdueCheckRun: unknown };
    expect(body.lastOverdueCheckRun).toBeNull();
  });

  it('reflects a failed run as status "failure" with its error category', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()], gmailTokenStatus: 401 });
    await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);

    const t = await serviceToken(env.FINANCE_INTERNAL_SECRET!);
    const res = await app.fetch(new Request(`${BASE}/internal/health/detailed`, { headers: { 'X-Service-Assertion': t } }), env);
    const body = (await res.json()) as { lastOverdueCheckRun: { status: string; errorCategory: string | null; reminderCount: number | null } };
    expect(body.lastOverdueCheckRun.status).toBe('failure');
    expect(body.lastOverdueCheckRun.errorCategory).toBe('auth_failed');
    expect(body.lastOverdueCheckRun.reminderCount).toBe(1);
  });

  it('reflects a successful run as status "success" with the real reminder count', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice(), overdueInvoice({ DocNumber: '1002' }), overdueInvoice({ DocNumber: '1003' })] });
    await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);

    const t = await serviceToken(env.FINANCE_INTERNAL_SECRET!);
    const res = await app.fetch(new Request(`${BASE}/internal/health/detailed`, { headers: { 'X-Service-Assertion': t } }), env);
    const body = (await res.json()) as { lastOverdueCheckRun: { status: string; reminderCount: number | null } };
    expect(body.lastOverdueCheckRun.status).toBe('success');
    expect(body.lastOverdueCheckRun.reminderCount).toBe(3);
  });

  it('a dry run never changes the last recorded outcome', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    stubQboAndGmail({ invoices: [overdueInvoice()], gmailTokenStatus: 401 });
    await app.fetch(new Request(`${BASE}/api/cron/overdue-check`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);

    stubQboAndGmail({ invoices: [overdueInvoice()] });
    await app.fetch(new Request(`${BASE}/api/cron/overdue-check?dryRun=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);

    const t = await serviceToken(env.FINANCE_INTERNAL_SECRET!);
    const res = await app.fetch(new Request(`${BASE}/internal/health/detailed`, { headers: { 'X-Service-Assertion': t } }), env);
    const body = (await res.json()) as { lastOverdueCheckRun: { status: string } };
    // Still reflects the earlier real (failed) run, not the dry run.
    expect(body.lastOverdueCheckRun.status).toBe('failure');
  });
});
