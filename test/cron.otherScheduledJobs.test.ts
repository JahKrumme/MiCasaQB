// Regression coverage for the three remaining scheduled financial email
// jobs (30-day-alert, monthly-invoices, kancare-reminder), hardened with
// the same architecture proven on the Daily Overdue Check: typed Gmail
// errors (never a substring match), safe dry-run, safe diagnostic mode,
// and defensive audit-write handling. Never sends a real email — Gmail is
// always mocked via a stubbed global fetch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { TokenRepository, type TokenBundle } from '../src/lib/tokenRepository';
import { listAuditLog } from '../src/lib/auditLog';

const BASE = 'https://test.example.com';
const QBO_API = 'https://sandbox-quickbooks.api.intuit.com';
const GMAIL_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

function freshBundle(realmId: string): TokenBundle {
  const now = Date.now();
  return {
    access_token: 'qb-access-token', refresh_token: 'qb-refresh-token', token_type: 'bearer',
    access_token_expires_at: now + 60 * 60 * 1000, refresh_token_expires_at: now + 100 * 24 * 60 * 60 * 1000, realm_id: realmId
  };
}

async function connectRealm(env: ReturnType<typeof createTestEnv>, realmId = 'realm-1') {
  await new TokenRepository(env).upsertConnection(realmId, freshBundle(realmId));
  return realmId;
}

function invoice(overrides: Record<string, unknown> = {}) {
  return { DocNumber: '2001', CustomerRef: { name: 'Test Customer' }, DueDate: '2026-05-01', TxnDate: '2026-08-01', Balance: '200.00', TotalAmt: '200.00', ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubQboAndGmail(opts: { invoices?: Record<string, unknown>[]; gmailTokenStatus?: number; gmailTokenErrorCode?: string | null; gmailSendStatus?: number }) {
  const invoices = opts.invoices ?? [];
  fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith(QBO_API)) {
      return new Response(JSON.stringify({ QueryResponse: { Invoice: invoices } }), { status: 200 });
    }
    if (url === GMAIL_TOKEN_URL) {
      const status = opts.gmailTokenStatus ?? 200;
      if (status === 200) return new Response(JSON.stringify({ access_token: 'fake-gmail-access-token' }), { status: 200 });
      const errorCode = opts.gmailTokenErrorCode === undefined ? 'invalid_grant' : opts.gmailTokenErrorCode;
      return errorCode === null
        ? new Response('unauthorized', { status })
        : new Response(JSON.stringify({ error: errorCode, error_description: 'Token has been expired or revoked.' }), { status });
    }
    if (url === GMAIL_SEND_URL) {
      const status = opts.gmailSendStatus ?? 200;
      return status === 200 ? new Response(JSON.stringify({ id: 'msg-1' }), { status: 200 }) : new Response(JSON.stringify({ error: 'quota exceeded' }), { status });
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

const JOBS = [
  { path: '30-day-alert', label: '30-day-alert', succeeded: 'scheduled_30_day_alert_succeeded', failed: 'scheduled_30_day_alert_failed', usesQuickBooks: true },
  { path: 'monthly-invoices', label: 'monthly-invoices', succeeded: 'scheduled_monthly_invoices_succeeded', failed: 'scheduled_monthly_invoices_failed', usesQuickBooks: true },
  { path: 'kancare-reminder', label: 'kancare-reminder', succeeded: 'scheduled_kancare_reminder_succeeded', failed: 'scheduled_kancare_reminder_failed', usesQuickBooks: false }
] as const;

for (const job of JOBS) {
  describe(`POST /api/cron/${job.path}`, () => {
    it('rejects a missing/wrong X-Cron-Secret', async () => {
      const env = createTestEnv();
      const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}`, { method: 'POST', headers: { 'X-Cron-Secret': 'wrong' } }), env);
      expect(res.status).toBe(401);
    });

    if (job.usesQuickBooks) {
      it('returns 503 no-token without ever touching Gmail when QuickBooks is not connected', async () => {
        const env = createTestEnv();
        const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
        expect(res.status).toBe(503);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }

    it('sends successfully and records a safe success audit event with the real record count', async () => {
      const env = createTestEnv();
      if (job.usesQuickBooks) await connectRealm(env);
      stubQboAndGmail({ invoices: [invoice(), invoice({ DocNumber: '2002' })] });
      const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; runId: string };
      expect(body.status).toBe('ok');

      const log = await listAuditLog(env, 10);
      const entry = log.find(e => e.action === job.succeeded);
      expect(entry).toBeTruthy();
      expect(JSON.stringify(entry)).not.toMatch(/Test Customer|200\.00/);
    });

    it('returns 502 invalid_client (never a bare 500) when the Gmail client credentials are rejected, and never attempts a send', async () => {
      const env = createTestEnv();
      if (job.usesQuickBooks) await connectRealm(env);
      stubQboAndGmail({ invoices: [invoice()], gmailTokenStatus: 401, gmailTokenErrorCode: 'invalid_client' });
      const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
      expect(res.status).toBe(502);
      const raw = await res.text();
      expect(raw).not.toContain('Internal server error');
      const body = JSON.parse(raw) as { status: string; errorCategory: string };
      expect(body.status).toBe('gmail-error');
      expect(body.errorCategory).toBe('invalid_client');

      expect(fetchMock.mock.calls.some(([url]) => String(url) === GMAIL_SEND_URL)).toBe(false);
      const log = await listAuditLog(env, 10);
      const entry = log.find(e => e.action === job.failed);
      expect(entry).toBeTruthy();
      expect((entry!.metadata as { errorCategory?: string })?.errorCategory).toBe('invalid_client');
      expect(JSON.stringify(entry)).not.toMatch(/Token has been expired or revoked/);
    });

    it('?dryRun=true never calls Gmail\'s send endpoint and records no audit event', async () => {
      const env = createTestEnv();
      if (job.usesQuickBooks) await connectRealm(env);
      stubQboAndGmail({ invoices: [invoice()] });
      const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}?dryRun=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; dryRun: boolean; gmailAuthOk: boolean };
      expect(body.status).toBe('ok');
      expect(body.dryRun).toBe(true);
      expect(body.gmailAuthOk).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => String(url) === GMAIL_SEND_URL)).toBe(false);

      const log = await listAuditLog(env, 10);
      expect(log.some(e => e.action === job.succeeded || e.action === job.failed)).toBe(false);
    });

    it('?dryRun=true reports gmailAuthOk:false without crashing when Gmail credentials are rejected', async () => {
      const env = createTestEnv();
      if (job.usesQuickBooks) await connectRealm(env);
      stubQboAndGmail({ invoices: [invoice()], gmailTokenStatus: 401, gmailTokenErrorCode: 'invalid_client' });
      const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}?dryRun=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { gmailAuthOk: boolean };
      expect(body.gmailAuthOk).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url) === GMAIL_SEND_URL)).toBe(false);
    });

    it('?diagnostic=true exercises the real path (recipients, message build, Gmail auth) and stops before sending, on success', async () => {
      const env = createTestEnv();
      if (job.usesQuickBooks) await connectRealm(env);
      stubQboAndGmail({ invoices: [invoice()] });
      const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}?diagnostic=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; job: string; phase: string; hasRecipients: boolean; gmailAuthOk: boolean; messageBuilt: boolean };
      expect(body.ok).toBe(true);
      expect(body.phase).toBe('ready');
      expect(body.hasRecipients).toBe(true);
      expect(body.gmailAuthOk).toBe(true);
      expect(body.messageBuilt).toBe(true);
      expect(fetchMock.mock.calls.some(([url]) => String(url) === GMAIL_SEND_URL)).toBe(false);

      const log = await listAuditLog(env, 10);
      expect(log.some(e => e.action === job.succeeded || e.action === job.failed)).toBe(false);
    });

    it('?diagnostic=true reports phase gmail_auth / category invalid_client when the client credentials are rejected, and never sends', async () => {
      const env = createTestEnv();
      if (job.usesQuickBooks) await connectRealm(env);
      stubQboAndGmail({ invoices: [invoice()], gmailTokenStatus: 401, gmailTokenErrorCode: 'invalid_client' });
      const res = await app.fetch(new Request(`${BASE}/api/cron/${job.path}?diagnostic=true`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; phase: string; category: string };
      expect(body.ok).toBe(false);
      expect(body.phase).toBe('gmail_auth');
      expect(body.category).toBe('invalid_client');
      expect(fetchMock.mock.calls.some(([url]) => String(url) === GMAIL_SEND_URL)).toBe(false);
    });
  });
}

describe('GET /internal/health/detailed — surfaces all four scheduled jobs independently', () => {
  function serviceToken(secret: string) {
    return import('./helpers/signAssertion').then(({ signTestAssertion }) =>
      signTestAssertion(secret, { sub: 'system', org: 'micasa', role: 'admin', permissions: ['finance.connectionHealth.view'] })
    );
  }

  it('reports null for every job when nothing has ever run', async () => {
    const env = createTestEnv();
    const t = await serviceToken(env.FINANCE_INTERNAL_SECRET!);
    const res = await app.fetch(new Request(`${BASE}/internal/health/detailed`, { headers: { 'X-Service-Assertion': t } }), env);
    const body = (await res.json()) as { last30DayAlertRun: unknown; lastMonthlyInvoicesRun: unknown; lastKanCareReminderRun: unknown };
    expect(body.last30DayAlertRun).toBeNull();
    expect(body.lastMonthlyInvoicesRun).toBeNull();
    expect(body.lastKanCareReminderRun).toBeNull();
  });

  it('a failure in one job never affects the recorded status of another', async () => {
    const env = createTestEnv();
    await connectRealm(env);

    stubQboAndGmail({ invoices: [invoice()] });
    await app.fetch(new Request(`${BASE}/api/cron/30-day-alert`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);

    stubQboAndGmail({ invoices: [invoice()], gmailTokenStatus: 401, gmailTokenErrorCode: 'invalid_client' });
    await app.fetch(new Request(`${BASE}/api/cron/monthly-invoices`, { method: 'POST', headers: { 'X-Cron-Secret': env.CRON_SECRET! } }), env);

    const t = await serviceToken(env.FINANCE_INTERNAL_SECRET!);
    const res = await app.fetch(new Request(`${BASE}/internal/health/detailed`, { headers: { 'X-Service-Assertion': t } }), env);
    const body = (await res.json()) as {
      last30DayAlertRun: { status: string } | null;
      lastMonthlyInvoicesRun: { status: string; errorCategory: string | null } | null;
      lastKanCareReminderRun: unknown;
    };
    expect(body.last30DayAlertRun?.status).toBe('success');
    expect(body.lastMonthlyInvoicesRun?.status).toBe('failure');
    expect(body.lastMonthlyInvoicesRun?.errorCategory).toBe('invalid_client');
    expect(body.lastKanCareReminderRun).toBeNull();
  });
});
