// Internal, machine-to-machine routes the Mi Casa Operations Hub calls via
// the FINANCE Service Binding (see MiCasaOpsHub/src/lib/financeClient.ts).
// Every route here is protected exclusively by requireServiceAssertion — no
// staff session cookie is ever accepted or expected. These routes never
// return QuickBooks access/refresh tokens, OAuth codes, or full financial
// records (raw invoice line items, exact dollar totals) — only safe
// status/count summaries, per docs in MiCasaOpsHub/docs/.
import { Hono } from 'hono';
import type { AppEnv } from '../honoTypes';
import { requireServiceAssertion, requireServicePermission } from '../middleware/internalAuth';
import { TokenRepository } from '../lib/tokenRepository';
import { qbQuery, QboApiError } from '../lib/qboClient';
import { recordAuditEvent } from '../lib/auditLog';

export const internalRoutes = new Hono<AppEnv>();

// Unauthenticated on purpose, unlike every other route below — the Hub's
// integration-health check needs to distinguish "Finance is unreachable"
// from "Finance is reachable but our assertion was rejected", and a health
// probe should never itself require a fresh signed assertion. Mirrors
// GET /api/health's own minimal-disclosure design (see src/index.ts).
internalRoutes.get('/health', c => c.json({ status: 'ok' }));

internalRoutes.use('*', requireServiceAssertion);

interface QboInvoiceRow {
  DocNumber?: string;
  CustomerRef?: { name?: string };
  DueDate?: string;
}

internalRoutes.get('/connection-status', requireServicePermission('finance.connectionHealth.view'), async c => {
  const repo = new TokenRepository(c.env);
  const realmId = await repo.getActiveRealmId();
  return c.json({
    connected: !!realmId,
    reconnectionRequired: !realmId
  });
});

internalRoutes.get('/follow-up-summary', requireServicePermission('finance.followUps.view'), async c => {
  const repo = new TokenRepository(c.env);
  const realmId = await repo.getActiveRealmId();
  if (!realmId) {
    return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  }

  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const data = await qbQuery(
      c.env,
      realmId,
      `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${todayStr}' ORDER BY DueDate ASC MAXRESULTS 50`
    );
    const invoices = (data.QueryResponse?.Invoice ?? []) as QboInvoiceRow[];

    // Deliberately omits dollar amounts/balances — this crosses a
    // service boundary into a shared Hub dashboard, so only the minimum
    // needed to create/prioritize a CRM follow-up task is included.
    const items = invoices.map(inv => ({
      invoiceRef: inv.DocNumber || null,
      customerLabel: inv.CustomerRef?.name || 'Unknown',
      daysOverdue: inv.DueDate ? Math.floor((today.getTime() - new Date(inv.DueDate).getTime()) / (1000 * 60 * 60 * 24)) : null
    }));

    return c.json({ overdueCount: items.length, items });
  } catch (e) {
    const status = e instanceof QboApiError ? e.status : 502;
    console.error('[internal/follow-up-summary]', e instanceof Error ? e.name : 'unknown', status);
    return c.json({ error: 'Unable to load follow-up summary right now' }, 502);
  }
});

internalRoutes.post('/billing-setup-request', requireServicePermission('finance.billingSetup.request'), async c => {
  const assertion = c.get('serviceAssertion')!;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const crmRecordId = typeof body.crmRecordId === 'string' ? body.crmRecordId : null;

  // Phase 2 scope: acknowledge and audit the request only. Actually creating
  // a QuickBooks customer/invoice remains a reviewed, human action inside
  // QuickBooks Companion's own UI (see src/routes/qboApi.ts's
  // preview-resident/create-resident) — this route does not call qbCreate.
  await recordAuditEvent(c.env, {
    actor: null,
    action: 'finance_billing_setup_requested',
    target: crmRecordId ?? undefined,
    metadata: { hubUserEmail: assertion.sub, crmRecordId }
  });

  return c.json({ acknowledged: true });
});

internalRoutes.post('/task-resolution', requireServicePermission('finance.followUps.resolve'), async c => {
  const assertion = c.get('serviceAssertion')!;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const crmTaskId = typeof body.crmTaskId === 'string' ? body.crmTaskId : null;

  await recordAuditEvent(c.env, {
    actor: null,
    action: 'finance_followup_resolved',
    target: crmTaskId ?? undefined,
    metadata: { hubUserEmail: assertion.sub, crmTaskId }
  });

  return c.json({ acknowledged: true });
});
