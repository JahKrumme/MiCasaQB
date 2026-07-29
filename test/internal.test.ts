import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { signTestAssertion } from './helpers/signAssertion';
import { TokenRepository, type TokenBundle } from '../src/lib/tokenRepository';
import { listAuditLog } from '../src/lib/auditLog';

const BASE = 'https://test.example.com/internal';

function req(path: string, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, init);
}

async function connectRealm(env: ReturnType<typeof createTestEnv>) {
  const realmId = `realm-${crypto.randomUUID()}`;
  const now = Date.now();
  const bundle: TokenBundle = {
    access_token: 'fake-access-token',
    refresh_token: 'fake-refresh-token',
    token_type: 'bearer',
    access_token_expires_at: now + 3600_000,
    refresh_token_expires_at: now + 1_000_000_000,
    realm_id: realmId
  };
  await new TokenRepository(env).upsertConnection(realmId, bundle);
  return realmId;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /internal/health', () => {
  it('requires no assertion at all', async () => {
    const env = createTestEnv();
    const res = await app.fetch(req('/health'), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});

describe('requireServiceAssertion', () => {
  it('rejects a request with no assertion header', async () => {
    const env = createTestEnv();
    const res = await app.fetch(req('/connection-status'), env);
    expect(res.status).toBe(401);
  });

  it('rejects a valid-shaped token signed with the wrong secret', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion('wrong-secret', {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['finance.connectionHealth.view']
    });
    const res = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(401);
  });

  it('rejects an expired assertion', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['finance.connectionHealth.view'],
      exp: Date.now() - 1000
    });
    const res = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(401);
  });

  it('rejects a malformed token', async () => {
    const env = createTestEnv();
    const res = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': 'not-a-real-token' } }), env);
    expect(res.status).toBe(401);
  });

  it('rejects a replayed assertion (same jti reused)', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['finance.connectionHealth.view']
    });
    const first = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    expect(first.status).toBe(200);
    const second = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    expect(second.status).toBe(401);
  });

  it('returns 503 (not a crash) when FINANCE_INTERNAL_SECRET is not configured', async () => {
    const env = createTestEnv({ FINANCE_INTERNAL_SECRET: undefined });
    const token = await signTestAssertion('anything', {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['finance.connectionHealth.view']
    });
    const res = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(503);
  });
});

describe('requireServicePermission', () => {
  it('rejects an otherwise-valid assertion missing the required permission', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['some.other.permission']
    });
    const res = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(403);
  });
});

describe('GET /internal/connection-status', () => {
  it('reports not connected with no QuickBooks realm', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'admin@example.com',
      org: 'micasa',
      role: 'admin',
      permissions: ['finance.connectionHealth.view']
    });
    const res = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, reconnectionRequired: true });
  });

  it('reports connected without ever including a token', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'admin@example.com',
      org: 'micasa',
      role: 'admin',
      permissions: ['finance.connectionHealth.view']
    });
    const res = await app.fetch(req('/connection-status', { headers: { 'X-Service-Assertion': token } }), env);
    const rawBody = await res.text();
    expect(rawBody).not.toMatch(/access_token|refresh_token|fake-access-token|fake-refresh-token/i);
    expect(JSON.parse(rawBody)).toEqual({ connected: true, reconnectionRequired: false });
  });
});

describe('GET /internal/health/detailed', () => {
  it('reports presence-only config flags and never leaks a token, even when connected', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'admin@example.com',
      org: 'micasa',
      role: 'admin',
      permissions: ['finance.connectionHealth.view']
    });
    const res = await app.fetch(req('/health/detailed', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(200);
    const rawBody = await res.text();
    expect(rawBody).not.toMatch(/access_token|refresh_token|fake-access-token|fake-refresh-token/i);
    const body = JSON.parse(rawBody);
    expect(body.oauthConnected).toBe(true);
    expect(body.reconnectionRequired).toBe(false);
    expect(typeof body.gmailConfigured).toBe('boolean');
    expect(typeof body.groqConfigured).toBe('boolean');
  });
});

describe('GET /internal/follow-up-summary', () => {
  it('returns 503 when QuickBooks is not connected', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['finance.followUps.view']
    });
    const res = await app.fetch(req('/follow-up-summary', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(503);
  });

  it('never includes a dollar amount/balance field, only safe counts and labels', async () => {
    const env = createTestEnv();
    await connectRealm(env);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            QueryResponse: {
              Invoice: [
                { DocNumber: 'INV-1001', CustomerRef: { name: 'Jane Resident' }, DueDate: '2026-06-01', Balance: '4200.00', TotalAmt: '4200.00' }
              ]
            }
          }),
          { status: 200 }
        )
      )
    );
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['finance.followUps.view']
    });
    const res = await app.fetch(req('/follow-up-summary', { headers: { 'X-Service-Assertion': token } }), env);
    expect(res.status).toBe(200);
    const rawBody = await res.text();
    expect(rawBody).not.toMatch(/balance|totalAmt|4200/i);
    const body = JSON.parse(rawBody);
    expect(body.overdueCount).toBe(1);
    expect(body.items[0]).toEqual({
      invoiceRef: 'INV-1001',
      customerLabel: 'Jane Resident',
      daysOverdue: expect.any(Number)
    });
  });
});

describe('POST /internal/billing-setup-request', () => {
  it('acknowledges and records an audit event with the acting Hub user, not a QuickBooks Companion user id', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'staff@example.com',
      org: 'micasa',
      role: 'staff',
      permissions: ['finance.billingSetup.request']
    });
    const res = await app.fetch(
      req('/billing-setup-request', {
        method: 'POST',
        headers: { 'X-Service-Assertion': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ crmRecordId: 'resident-123' })
      }),
      env
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ acknowledged: true });

    const log = await listAuditLog(env, 10);
    const entry = log.find(e => e.action === 'finance_billing_setup_requested');
    expect(entry).toBeTruthy();
    expect(entry?.actorUserId).toBeNull();
    expect(entry?.metadata).toEqual({ callerEmail: 'staff@example.com', crmRecordId: 'resident-123' });
  });
});

describe('POST /internal/task-resolution', () => {
  it('acknowledges and records an audit event', async () => {
    const env = createTestEnv();
    const token = await signTestAssertion(env.FINANCE_INTERNAL_SECRET!, {
      sub: 'admin@example.com',
      org: 'micasa',
      role: 'admin',
      permissions: ['finance.followUps.resolve']
    });
    const res = await app.fetch(
      req('/task-resolution', {
        method: 'POST',
        headers: { 'X-Service-Assertion': token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ crmTaskId: 'task-456' })
      }),
      env
    );
    expect(res.status).toBe(200);
    const log = await listAuditLog(env, 10);
    expect(log.some(e => e.action === 'finance_followup_resolved')).toBe(true);
  });
});
