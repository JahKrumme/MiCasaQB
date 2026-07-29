// Internal, machine-to-machine routes MiCasaCRM calls (formerly the Mi Casa
// Operations Hub, via its FINANCE Service Binding — see
// docs/UNIFIED_APP_MIGRATION.md for the migration history). Every route here
// is protected exclusively by requireServiceAssertion — no staff session
// cookie is ever accepted or expected. These routes never return QuickBooks
// access/refresh tokens, OAuth codes, or the Intuit client secret — only
// safe status/count summaries and the specific fields each screen needs.
import { Hono } from 'hono';
import type { AppEnv } from '../honoTypes';
import type { Env } from '../env';
import { requireServiceAssertion, requireServicePermission } from '../middleware/internalAuth';
import { getBaseUrl } from '../lib/baseUrl';
import { TokenRepository } from '../lib/tokenRepository';
import { qbQuery, qbCreate, disconnectRealm, QboApiError } from '../lib/qboClient';
import { buildAuthorizeUrl } from '../lib/intuitOAuth';
import { createOAuthState } from '../lib/oauthState';
import { recordAuditEvent } from '../lib/auditLog';
import { sha256Hex, randomToken } from '../lib/crypto';
import { groqChatCompletion, GroqError, type ChatMessage } from '../lib/groq';
import { getActiveCustomerNames, getResidentRates } from './qboApi';

export const internalRoutes = new Hono<AppEnv>();

// Unauthenticated on purpose, unlike every other route below — the caller's
// integration-health check needs to distinguish "Finance is unreachable"
// from "Finance is reachable but our assertion was rejected."
internalRoutes.get('/health', c => c.json({ status: 'ok' }));

internalRoutes.use('*', requireServiceAssertion);

interface QboCustomer {
  Id?: string;
  DisplayName?: string;
  FullyQualifiedName?: string;
  PrimaryEmailAddr?: { Address?: string };
  PrimaryPhone?: { FreeFormNumber?: string };
  Balance?: string | number;
  Active?: boolean;
}
interface QboInvoice {
  Id?: string;
  DocNumber?: string;
  CustomerRef?: { value?: string; name?: string };
  TxnDate?: string;
  DueDate?: string;
  TotalAmt?: string | number;
  Balance?: string | number;
}

function handleQboError(e: unknown, label: string): { error: string } {
  const status = e instanceof QboApiError ? e.status : 500;
  console.error(`[internal ERROR] ${label}:`, e instanceof Error ? e.name : 'unknown', status);
  return { error: 'QuickBooks request failed.' };
}

async function requireConnectedRealm(c: { env: Env }): Promise<string | null> {
  const repo = new TokenRepository(c.env);
  return repo.getActiveRealmId();
}

internalRoutes.get('/connection-status', requireServicePermission('finance.connectionHealth.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  return c.json({ connected: !!realmId, reconnectionRequired: !realmId });
});

// Backs the CRM's Admin -> Integration Health page. Presence-only checks
// (never a live network probe) for Gmail/Groq — same discipline as
// financeConfigured()'s own env-presence check elsewhere in this file;
// "configured" here means credentials are present, not that they're
// verified working, which this page's own labels make clear.
internalRoutes.get('/health/detailed', requireServicePermission('finance.connectionHealth.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  return c.json({
    oauthConnected: !!realmId,
    reconnectionRequired: !realmId,
    intuitConfigured: Boolean(c.env.INTUIT_CLIENT_ID && c.env.INTUIT_CLIENT_SECRET),
    gmailConfigured: Boolean(c.env.GMAIL_CLIENT_ID && c.env.GMAIL_CLIENT_SECRET && c.env.GMAIL_REFRESH_TOKEN),
    groqConfigured: Boolean(c.env.GROQ_API_KEY)
  });
});

internalRoutes.get('/follow-up-summary', requireServicePermission('finance.followUps.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);

  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const data = await qbQuery(
      c.env,
      realmId,
      `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${todayStr}' ORDER BY DueDate ASC MAXRESULTS 50`
    );
    const invoices = (data.QueryResponse?.Invoice ?? []) as QboInvoice[];
    const items = invoices.map(inv => ({
      invoiceRef: inv.DocNumber || null,
      customerLabel: inv.CustomerRef?.name || 'Unknown',
      daysOverdue: inv.DueDate ? Math.floor((today.getTime() - new Date(inv.DueDate).getTime()) / (1000 * 60 * 60 * 24)) : null
    }));
    return c.json({ overdueCount: items.length, items });
  } catch (e) {
    return c.json(handleQboError(e, 'follow-up-summary'), 502);
  }
});

internalRoutes.post('/billing-setup-request', requireServicePermission('finance.billingSetup.request'), async c => {
  const assertion = c.get('serviceAssertion')!;
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const crmRecordId = typeof body.crmRecordId === 'string' ? body.crmRecordId : null;

  await recordAuditEvent(c.env, {
    actor: null,
    action: 'finance_billing_setup_requested',
    target: crmRecordId ?? undefined,
    metadata: { callerEmail: assertion.sub, crmRecordId }
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
    metadata: { callerEmail: assertion.sub, crmTaskId }
  });
  return c.json({ acknowledged: true });
});
// Alias under Finance-scoped naming for the new CRM UI — same behavior,
// kept as a distinct path (not a rename) so the Hub's rollback path above
// keeps working unchanged.
internalRoutes.post('/payments/:id/resolve-follow-up-task', requireServicePermission('finance.followUps.resolve'), async c => {
  const assertion = c.get('serviceAssertion')!;
  await recordAuditEvent(c.env, {
    actor: null,
    action: 'finance_followup_resolved',
    target: c.req.param('id'),
    metadata: { callerEmail: assertion.sub, crmTaskId: c.req.param('id') }
  });
  return c.json({ acknowledged: true });
});

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

internalRoutes.get('/customers', requireServicePermission('finance.customers.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  try {
    const search = (c.req.query('search') || '').toLowerCase();
    const data = await qbQuery(c.env, realmId, 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
    let customers = (data.QueryResponse?.Customer ?? []) as QboCustomer[];
    if (search) {
      customers = customers.filter(cu => (cu.DisplayName || cu.FullyQualifiedName || '').toLowerCase().includes(search));
    }
    return c.json({
      customers: customers.map(cu => ({
        id: cu.Id,
        name: cu.DisplayName || cu.FullyQualifiedName,
        email: cu.PrimaryEmailAddr?.Address || null,
        phone: cu.PrimaryPhone?.FreeFormNumber || null,
        balance: Number(cu.Balance ?? 0)
      }))
    });
  } catch (e) {
    return c.json(handleQboError(e, 'customers'), 502);
  }
});

internalRoutes.get('/customers/:id', requireServicePermission('finance.customers.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  try {
    const id = c.req.param('id');
    const custData = await qbQuery(c.env, realmId, `SELECT * FROM Customer WHERE Id = '${id}'`);
    const customer = (custData.QueryResponse?.Customer ?? [])[0] as QboCustomer | undefined;
    if (!customer) return c.json({ error: 'Customer not found' }, 404);

    const invData = await qbQuery(c.env, realmId, `SELECT * FROM Invoice WHERE CustomerRef = '${id}' ORDER BY TxnDate DESC MAXRESULTS 20`);
    const invoices = (invData.QueryResponse?.Invoice ?? []) as QboInvoice[];

    return c.json({
      customer: {
        id: customer.Id,
        name: customer.DisplayName || customer.FullyQualifiedName,
        email: customer.PrimaryEmailAddr?.Address || null,
        phone: customer.PrimaryPhone?.FreeFormNumber || null,
        balance: Number(customer.Balance ?? 0)
      },
      recentInvoices: invoices.map(inv => ({
        id: inv.Id,
        docNumber: inv.DocNumber || null,
        txnDate: inv.TxnDate || null,
        dueDate: inv.DueDate || null,
        totalAmt: Number(inv.TotalAmt ?? 0),
        balance: Number(inv.Balance ?? 0)
      }))
    });
  } catch (e) {
    return c.json(handleQboError(e, 'customers/:id'), 502);
  }
});

internalRoutes.post('/customers/prepare', requireServicePermission('finance.customers.manage'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  try {
    const { name, paymentType, monthlyRate, moveInDate } = (await c.req.json()) as {
      name: string; paymentType: string; monthlyRate: number; moveInDate: string;
    };
    const custData = await qbQuery(c.env, realmId, 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
    const customers = (custData.QueryResponse?.Customer ?? []) as QboCustomer[];
    const duplicate = customers.find(cu => cu.DisplayName?.toLowerCase() === name.toLowerCase());
    return c.json({ name, paymentType, monthlyRate: Number(monthlyRate), moveInDate, isDuplicate: !!duplicate });
  } catch (e) {
    return c.json(handleQboError(e, 'customers/prepare'), 502);
  }
});

internalRoutes.post('/customers/confirm', requireServicePermission('finance.customers.manage'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  const assertion = c.get('serviceAssertion')!;
  try {
    const body = (await c.req.json()) as { name?: unknown; confirm?: unknown };
    if (typeof body.name !== 'string' || !body.name) return c.json({ error: 'name is required' }, 400);
    if (body.confirm !== true) return c.json({ error: 'confirm:true is required' }, 400);

    const { name, paymentType, monthlyRate, moveInDate } = body as { name: string; paymentType?: string; monthlyRate?: number; moveInDate?: string };
    const notes = `Payment type: ${paymentType || 'n/a'} | Monthly rate: $${Number(monthlyRate || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })} | Move-in date: ${moveInDate || 'n/a'}`;

    const result = await qbCreate(c.env, realmId, 'customer', { DisplayName: name, PrintOnCheckName: name, Notes: notes });
    const customerId = result.Customer?.Id;

    await recordAuditEvent(c.env, {
      actor: null,
      action: 'finance_customer_created',
      target: customerId,
      metadata: { callerEmail: assertion.sub, name }
    });

    return c.json({ success: true, customerId, name, monthlyRate: Number(monthlyRate || 0), paymentType, moveInDate });
  } catch (e) {
    return c.json(handleQboError(e, 'customers/confirm'), 502);
  }
});

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

internalRoutes.get('/invoices', requireServicePermission('finance.invoices.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  try {
    const status = c.req.query('status'); // 'overdue' | 'open' | undefined
    const customerId = c.req.query('customerId');
    let query = 'SELECT * FROM Invoice WHERE 1=1';
    if (customerId) query += ` AND CustomerRef = '${customerId}'`;
    if (status === 'open') query += ` AND Balance > '0'`;
    if (status === 'overdue') query += ` AND Balance > '0' AND DueDate < '${new Date().toISOString().split('T')[0]}'`;
    query += ' ORDER BY TxnDate DESC MAXRESULTS 100';

    const data = await qbQuery(c.env, realmId, query);
    const invoices = (data.QueryResponse?.Invoice ?? []) as QboInvoice[];
    return c.json({
      invoices: invoices.map(inv => ({
        id: inv.Id,
        docNumber: inv.DocNumber || null,
        customerId: inv.CustomerRef?.value || null,
        customerName: inv.CustomerRef?.name || 'Unknown',
        txnDate: inv.TxnDate || null,
        dueDate: inv.DueDate || null,
        totalAmt: Number(inv.TotalAmt ?? 0),
        balance: Number(inv.Balance ?? 0)
      }))
    });
  } catch (e) {
    return c.json(handleQboError(e, 'invoices'), 502);
  }
});

internalRoutes.get('/invoices/:id', requireServicePermission('finance.invoices.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  try {
    const id = c.req.param('id');
    const data = await qbQuery(c.env, realmId, `SELECT * FROM Invoice WHERE Id = '${id}'`);
    const invoice = (data.QueryResponse?.Invoice ?? [])[0] as QboInvoice | undefined;
    if (!invoice) return c.json({ error: 'Invoice not found' }, 404);
    return c.json({
      invoice: {
        id: invoice.Id,
        docNumber: invoice.DocNumber || null,
        customerId: invoice.CustomerRef?.value || null,
        customerName: invoice.CustomerRef?.name || 'Unknown',
        txnDate: invoice.TxnDate || null,
        dueDate: invoice.DueDate || null,
        totalAmt: Number(invoice.TotalAmt ?? 0),
        balance: Number(invoice.Balance ?? 0)
      }
    });
  } catch (e) {
    return c.json(handleQboError(e, 'invoices/:id'), 502);
  }
});

internalRoutes.post('/invoices/prepare', requireServicePermission('finance.invoices.manage'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  try {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
    const invoiceDate = new Date(today.getFullYear(), today.getMonth(), 20).toISOString().split('T')[0];
    const dueDate = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString().split('T')[0];

    const [custData, existingData, rates] = await Promise.all([
      qbQuery(c.env, realmId, 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 100'),
      qbQuery(c.env, realmId, `SELECT * FROM Invoice WHERE TxnDate >= '${firstDay}' AND TxnDate <= '${lastDay}' MAXRESULTS 100`),
      getResidentRates(c.env, realmId)
    ]);

    const customers = (custData.QueryResponse?.Customer ?? []) as QboCustomer[];
    const existingInvoices = (existingData.QueryResponse?.Invoice ?? []) as QboInvoice[];
    const invoicedCustomerIds = new Set(existingInvoices.map(inv => inv.CustomerRef?.value));

    const preview = customers
      .filter(cu => {
        const name = cu.DisplayName || cu.FullyQualifiedName;
        return name && rates[name] !== undefined;
      })
      .map(cu => {
        const name = (cu.DisplayName || cu.FullyQualifiedName)!;
        return { name, customerId: cu.Id, amount: rates[name], invoiceDate, dueDate, alreadyInvoiced: invoicedCustomerIds.has(cu.Id) };
      });

    const total = preview.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return c.json({ preview, invoiceDate, dueDate, total });
  } catch (e) {
    return c.json(handleQboError(e, 'invoices/prepare'), 502);
  }
});

internalRoutes.post('/invoices/create', requireServicePermission('finance.invoices.manage'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  const assertion = c.get('serviceAssertion')!;
  try {
    const body = (await c.req.json()) as {
      confirm?: unknown;
      idempotencyKey?: unknown;
      preview?: { name: string; customerId?: string; amount: number; invoiceDate: string; dueDate: string; alreadyInvoiced: boolean }[];
    };
    if (body.confirm !== true) return c.json({ error: 'confirm:true is required' }, 400);
    if (typeof body.idempotencyKey !== 'string' || !body.idempotencyKey) return c.json({ error: 'idempotencyKey is required' }, 400);
    const preview = Array.isArray(body.preview) ? body.preview : [];

    const itemData = await qbQuery(c.env, realmId, "SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 50");
    const items = (itemData.QueryResponse?.Item ?? []) as { Id: string; Name: string }[];
    const roomItem = items.find(i => /room|board|care|resident/i.test(i.Name)) || items[0];

    const results: { name: string; status: string; reason?: string; invoiceId?: string; amount?: number }[] = [];
    for (const r of preview) {
      if (!r.customerId) { results.push({ name: r.name, status: 'skipped', reason: 'Customer not found in QuickBooks' }); continue; }
      if (r.alreadyInvoiced) { results.push({ name: r.name, status: 'skipped', reason: 'Already invoiced this month' }); continue; }
      try {
        const result = await qbCreate(c.env, realmId, 'invoice', {
          Line: [{ Amount: r.amount, DetailType: 'SalesItemLineDetail', SalesItemLineDetail: { ItemRef: roomItem ? { value: roomItem.Id, name: roomItem.Name } : { value: '1', name: 'Services' }, Qty: 1, UnitPrice: r.amount } }],
          CustomerRef: { value: r.customerId },
          TxnDate: r.invoiceDate,
          DueDate: r.dueDate
        });
        results.push({ name: r.name, status: 'created', invoiceId: result.Invoice?.Id, amount: r.amount });
      } catch (e) {
        results.push({ name: r.name, status: 'error', reason: e instanceof Error ? e.message : 'Unknown error' });
      }
    }

    const created = results.filter(r => r.status === 'created');
    const total = created.reduce((sum, r) => sum + (r.amount ?? 0), 0);

    await recordAuditEvent(c.env, {
      actor: null,
      action: 'finance_invoice_created',
      target: body.idempotencyKey,
      metadata: { callerEmail: assertion.sub, created: created.length, total }
    });

    return c.json({ results, created: created.length, total });
  } catch (e) {
    return c.json(handleQboError(e, 'invoices/create'), 502);
  }
});

// Internal-task-only, by explicit decision — does not send a customer-facing
// email. Creates an audit trail; the CRM creates its own follow-up task for
// staff to act on from the response.
internalRoutes.post('/invoices/:id/remind', requireServicePermission('finance.invoices.remind'), async c => {
  const assertion = c.get('serviceAssertion')!;
  await recordAuditEvent(c.env, {
    actor: null,
    action: 'finance_invoice_reminder_requested',
    target: c.req.param('id'),
    metadata: { callerEmail: assertion.sub }
  });
  return c.json({ acknowledged: true });
});

// ---------------------------------------------------------------------------
// Payments — prepare -> confirm (mints a short-lived single-use token) ->
// record (consumes it). Prevents a retried network request from double-
// recording the same payment.
// ---------------------------------------------------------------------------

const ACTION_TOKEN_TTL_MS = 2 * 60 * 1000; // 2 minutes

async function payloadHashFor(payload: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(payload));
}

internalRoutes.post('/payments/prepare', requireServicePermission('finance.payments.view'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  try {
    const { customerName, amount } = (await c.req.json()) as { customerName: string; amount?: number | null };
    const custData = await qbQuery(c.env, realmId, 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
    const customers = (custData.QueryResponse?.Customer ?? []) as QboCustomer[];
    const customer = customers.find(cu => {
      const name = (cu.DisplayName || cu.FullyQualifiedName || '').toLowerCase();
      return name.includes(customerName.toLowerCase()) || customerName.toLowerCase().includes(name);
    });
    if (!customer) return c.json({ found: false, message: `No customer found matching "${customerName}"` });

    const invData = await qbQuery(c.env, realmId, `SELECT * FROM Invoice WHERE CustomerRef = '${customer.Id}' AND Balance > '0' ORDER BY TxnDate DESC MAXRESULTS 1`);
    const invoices = (invData.QueryResponse?.Invoice ?? []) as QboInvoice[];
    if (invoices.length === 0) return c.json({ found: false, message: `No open invoice found for ${customer.DisplayName}` });

    const invoice = invoices[0]!;
    const today = new Date().toISOString().split('T')[0];
    return c.json({
      found: true,
      customerId: customer.Id,
      customerName: customer.DisplayName,
      invoiceId: invoice.Id,
      invoiceNumber: invoice.DocNumber,
      invoiceAmount: Number(invoice.TotalAmt),
      invoiceBalance: Number(invoice.Balance),
      paymentAmount: amount || Number(invoice.Balance),
      paymentDate: today
    });
  } catch (e) {
    return c.json(handleQboError(e, 'payments/prepare'), 502);
  }
});

internalRoutes.post('/payments/confirm', requireServicePermission('finance.payments.manage'), async c => {
  const assertion = c.get('serviceAssertion')!;
  const body = (await c.req.json()) as { customerId?: unknown; invoiceId?: unknown; paymentAmount?: unknown; paymentDate?: unknown };
  if (typeof body.customerId !== 'string' || typeof body.invoiceId !== 'string' || typeof body.paymentAmount !== 'number' || typeof body.paymentDate !== 'string') {
    return c.json({ error: 'customerId, invoiceId, paymentAmount, and paymentDate are required' }, 400);
  }
  const payload = { customerId: body.customerId, invoiceId: body.invoiceId, paymentAmount: body.paymentAmount, paymentDate: body.paymentDate };
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const payloadHash = await payloadHashFor(payload);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO internal_action_tokens (token_hash, action, payload_hash, created_by, created_at, expires_at) VALUES (?, 'record_payment', ?, ?, ?, ?)`
  ).bind(tokenHash, payloadHash, assertion.sub, now, now + ACTION_TOKEN_TTL_MS).run();

  return c.json({ token, expiresInSeconds: ACTION_TOKEN_TTL_MS / 1000, ...payload });
});

internalRoutes.post('/payments/record', requireServicePermission('finance.payments.manage'), async c => {
  const realmId = await requireConnectedRealm(c);
  if (!realmId) return c.json({ error: 'QuickBooks is not connected', reconnectionRequired: true }, 503);
  const assertion = c.get('serviceAssertion')!;

  const body = (await c.req.json()) as { token?: unknown; customerId?: unknown; invoiceId?: unknown; paymentAmount?: unknown; paymentDate?: unknown };
  if (typeof body.token !== 'string' || !body.token) return c.json({ error: 'token is required' }, 400);
  if (typeof body.customerId !== 'string' || typeof body.invoiceId !== 'string' || typeof body.paymentAmount !== 'number' || typeof body.paymentDate !== 'string') {
    return c.json({ error: 'customerId, invoiceId, paymentAmount, and paymentDate are required' }, 400);
  }
  const payload = { customerId: body.customerId, invoiceId: body.invoiceId, paymentAmount: body.paymentAmount, paymentDate: body.paymentDate };

  const tokenHash = await sha256Hex(body.token);
  const row = await c.env.DB.prepare(`SELECT * FROM internal_action_tokens WHERE token_hash = ?`).bind(tokenHash).first<{
    action: string; payload_hash: string; expires_at: number; used_at: number | null;
  }>();
  if (!row) return c.json({ error: 'Invalid or expired confirmation token' }, 404);
  if (row.action !== 'record_payment') return c.json({ error: 'Invalid or expired confirmation token' }, 404);
  if (row.used_at) return c.json({ error: 'Invalid or expired confirmation token' }, 404);
  if (row.expires_at < Date.now()) return c.json({ error: 'Invalid or expired confirmation token' }, 404);
  const expectedHash = await payloadHashFor(payload);
  if (expectedHash !== row.payload_hash) return c.json({ error: 'Confirmation token does not match the submitted payment' }, 400);

  const claim = await c.env.DB.prepare(`UPDATE internal_action_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL`)
    .bind(Date.now(), tokenHash).run();
  if ((claim.meta.changes ?? 0) === 0) return c.json({ error: 'Confirmation token was already used' }, 404);

  try {
    const result = await qbCreate(c.env, realmId, 'payment', {
      CustomerRef: { value: payload.customerId },
      TotalAmt: payload.paymentAmount,
      TxnDate: payload.paymentDate,
      Line: [{ Amount: payload.paymentAmount, LinkedTxn: [{ TxnId: payload.invoiceId, TxnType: 'Invoice' }] }]
    });

    await recordAuditEvent(c.env, {
      actor: null,
      action: 'finance_payment_recorded',
      target: result.Payment?.Id,
      metadata: { callerEmail: assertion.sub, customerId: payload.customerId, invoiceId: payload.invoiceId, amount: payload.paymentAmount }
    });

    return c.json({ success: true, paymentId: result.Payment?.Id, amount: payload.paymentAmount });
  } catch (e) {
    return c.json(handleQboError(e, 'payments/record'), 502);
  }
});

// ---------------------------------------------------------------------------
// OAuth — the CRM-initiated branch. QuickBooks Companion's own standalone
// /api/qbo/connect|callback (src/routes/qbo.ts) is unchanged; this only adds
// a second, service-assertion-gated way to MINT the state that callback
// already knows how to recognize (the 'svc:' prefix branch there).
// ---------------------------------------------------------------------------

internalRoutes.post('/oauth/authorize-url', requireServicePermission('finance.oauth.connect'), async c => {
  if (!c.env.INTUIT_CLIENT_ID || !c.env.INTUIT_CLIENT_SECRET) {
    return c.json({ status: 'not_configured' });
  }
  const assertion = c.get('serviceAssertion')!;
  const state = await createOAuthState(c.env, `svc:${assertion.sub}`);
  const redirectUri = `${getBaseUrl(c)}/api/qbo/callback`;
  const url = buildAuthorizeUrl(c.env, redirectUri, state);
  return c.json({ status: 'ok', url });
});

internalRoutes.post('/oauth/disconnect', requireServicePermission('finance.oauth.disconnect'), async c => {
  const assertion = c.get('serviceAssertion')!;
  const repo = new TokenRepository(c.env);
  const realmId = await repo.getActiveRealmId();
  if (!realmId) return c.json({ success: true, message: 'Already disconnected.' });

  await disconnectRealm(c.env, realmId);
  await recordAuditEvent(c.env, { actor: null, action: 'qbo_disconnected', target: realmId, metadata: { callerEmail: assertion.sub } });
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// Finance Assistant (Groq chat) — ported from src/routes/chat.ts. Unlike the
// staff-facing version, the system prompt is never accepted from the caller
// (only a closed `promptVariant` enum) — the actual prompt text is built
// server-side, since this now crosses a service-assertion trust boundary
// rather than staying inside one same-origin session.
// ---------------------------------------------------------------------------

const FINANCE_ASSISTANT_PROMPT = [
  'You are the Mi Casa Finance Assistant, embedded in the Mi Casa CRM.',
  'You help staff understand resident billing, invoices, and payments in QuickBooks.',
  'Be concise and factual. Never invent dollar amounts, dates, or customer names not present in the data below.',
  'If asked to take an action (create an invoice, record a payment, add a resident), say the staff member should use the Finance pages\' own prepare/confirm flow — you cannot perform actions directly.'
].join(' ');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const INVOICE_KEYWORDS = ['create invoice', 'make invoice', 'invoices for', 'monthly invoices', 'bill residents'];
const PAYMENT_KEYWORDS = ['record payment', 'record a payment', 'received payment', 'payment from', 'payment for', 'log payment'];
const RESIDENT_KEYWORDS = ['add resident', 'new resident', 'add client', 'move in'];
const OVERDUE_KEYWORDS = ['overdue', 'unpaid', 'who owes', 'outstanding'];
const MAX_MESSAGE_LENGTH = 4000;
const MAX_MESSAGES = 50;
const VALID_ROLES = new Set(['user', 'assistant']); // never 'system' — the caller can't inject one

function validateChatRequest(body: unknown): { ok: true; messages: ChatMessage[] } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, error: 'Request body must be a JSON object.' };
  const { messages, promptVariant } = body as Record<string, unknown>;
  if (promptVariant !== 'finance-assistant') return { ok: false, error: 'Invalid or missing "promptVariant".' };
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: 'Missing or empty "messages" array.' };
  if (messages.length > MAX_MESSAGES) return { ok: false, error: `Too many messages (max ${MAX_MESSAGES}).` };
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) return { ok: false, error: 'Each message must be an object.' };
    const { role, content } = m as Record<string, unknown>;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) return { ok: false, error: 'Each message must have role "user" or "assistant".' };
    if (typeof content !== 'string' || content.length === 0 || content.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, error: `Each message needs non-empty content under ${MAX_MESSAGE_LENGTH} characters.` };
    }
  }
  return { ok: true, messages: messages as ChatMessage[] };
}

internalRoutes.post('/chat', requireServicePermission('finance.assistant.chat'), async c => {
  const validation = validateChatRequest(await c.req.json().catch(() => null));
  if (!validation.ok) return c.json({ error: validation.error }, 400);

  const { messages } = validation;
  const userContent = messages[messages.length - 1]?.content || '';
  const userMsgLower = userContent.toLowerCase();

  const realmId = await requireConnectedRealm(c);
  let customerNames: string[] = [];
  let customerRates: Record<string, number> = {};
  let customerSection: string;
  if (realmId) {
    try {
      const [names, rates] = await Promise.all([getActiveCustomerNames(c.env, realmId), getResidentRates(c.env, realmId)]);
      customerNames = names;
      customerRates = rates;
      const lines = names.map(name => {
        const rate = rates[name];
        return rate ? `- ${name}: $${Number(rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : `- ${name}: rate unknown`;
      });
      customerSection = `## Active Residents and Current Monthly Rates (pulled live from QuickBooks)\n${lines.join('\n')}`;
    } catch {
      customerSection = '## Active Residents\nCustomer list unavailable — QB token may need refresh.';
    }
  } else {
    customerSection = '## Active Residents\nQuickBooks is not connected yet.';
  }

  let intent: string | null = null;
  let paymentData: { customerName: string | null; amount: number | null } | null = null;
  const hasInvoiceWord = userMsgLower.includes('invoice') || userMsgLower.includes('invoices');
  const hasMonth = MONTHS.some(m => userMsgLower.includes(m));
  const hasPaid = userMsgLower.includes('paid') && !userMsgLower.includes('unpaid');

  if (INVOICE_KEYWORDS.some(kw => userMsgLower.includes(kw)) || (hasInvoiceWord && hasMonth)) {
    intent = 'create-invoices';
  } else if (PAYMENT_KEYWORDS.some(kw => userMsgLower.includes(kw)) || hasPaid) {
    intent = 'record-payment';
    const amountMatch = userContent.match(/\$?([\d,]+(?:\.\d{2})?)/);
    const extractedAmount = amountMatch ? parseFloat(amountMatch[1]!.replace(/,/g, '')) : null;
    const extractedName = customerNames.find(name => userMsgLower.includes(name.toLowerCase())) || null;
    const rateAmount = extractedName ? customerRates[extractedName] ?? null : null;
    paymentData = { customerName: extractedName, amount: extractedAmount || rateAmount };
  } else if (RESIDENT_KEYWORDS.some(kw => userMsgLower.includes(kw))) {
    intent = 'add-resident';
  } else if (OVERDUE_KEYWORDS.some(kw => userMsgLower.includes(kw))) {
    intent = 'overdue-summary';
  }

  if (intent) return c.json({ text: null, intent, paymentData });

  try {
    const augmentedSystem = FINANCE_ASSISTANT_PROMPT + '\n\n' + customerSection;
    const text = await groqChatCompletion(c.env, [{ role: 'system', content: augmentedSystem }, ...messages]);
    return c.json({ text, intent: null, paymentData: null });
  } catch (e) {
    if (e instanceof GroqError && e.category === 'missing_key') {
      return c.json({ error: 'The assistant is not configured yet. Please contact an administrator.' }, 503);
    }
    console.error('[internal/chat]', e instanceof Error ? e.name : 'unknown');
    return c.json({ error: 'The assistant is temporarily unavailable. Please try again.' }, 502);
  }
});
