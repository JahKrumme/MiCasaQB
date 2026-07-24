import { Hono } from 'hono';
import type { AppEnv } from '../honoTypes';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth';
import { requireSameOrigin } from '../middleware/security';
import { requireQboConnected } from '../middleware/qboConnected';
import { qbCreate, qbQuery, QboApiError } from '../lib/qboClient';

export const qboApiRoutes = new Hono<AppEnv>();
qboApiRoutes.use('*', requireAuth, blockIfPasswordChangeRequired, requireSameOrigin, requireQboConnected);

// Read Only accounts may view reports/summaries (the routes below with no
// extra role gate) but never create invoices/payments/residents.
const requireWriteAccess = requireRole('admin', 'staff');

interface QboCustomer {
  Id?: string;
  DisplayName?: string;
  FullyQualifiedName?: string;
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
  console.error(`[QB ROUTE ERROR] ${label}:`, e instanceof Error ? e.name : 'unknown', status);
  return { error: e instanceof Error ? sanitizeMessage(e.message) : 'QuickBooks request failed.' };
}

// Strip anything that looks like it could echo tokens/secrets back to the browser.
function sanitizeMessage(message: string): string {
  return message.replace(/(access_token|refresh_token|client_secret)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}

async function getActiveCustomerNames(env: Parameters<typeof qbQuery>[0], realmId: string): Promise<string[]> {
  const data = await qbQuery(env, realmId, 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
  const customers = (data.QueryResponse?.Customer ?? []) as QboCustomer[];
  return customers.map(c => c.DisplayName || c.FullyQualifiedName).filter((n): n is string => !!n);
}

async function getResidentRates(env: Parameters<typeof qbQuery>[0], realmId: string): Promise<Record<string, number>> {
  const data = await qbQuery(env, realmId, 'SELECT * FROM Invoice ORDER BY TxnDate DESC MAXRESULTS 200');
  const invoices = (data.QueryResponse?.Invoice ?? []) as QboInvoice[];
  const rates: Record<string, number> = {};
  for (const inv of invoices) {
    const name = inv.CustomerRef?.name;
    if (name && !(name in rates)) rates[name] = Number(inv.TotalAmt);
  }
  return rates;
}

qboApiRoutes.post('/preview-invoices', async c => {
  const realmId = c.get('realmId')!;
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
        return {
          name,
          customerId: cu.Id,
          amount: rates[name],
          invoiceDate,
          dueDate,
          alreadyInvoiced: invoicedCustomerIds.has(cu.Id)
        };
      });

    const total = preview.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return c.json({ preview, invoiceDate, dueDate, total });
  } catch (e) {
    return c.json(handleQboError(e, 'preview-invoices'), 500);
  }
});

qboApiRoutes.post('/create-invoices', requireWriteAccess, async c => {
  const realmId = c.get('realmId')!;
  try {
    const { preview } = (await c.req.json()) as {
      preview: { name: string; customerId?: string; amount: number; invoiceDate: string; dueDate: string; alreadyInvoiced: boolean }[];
    };

    const itemData = await qbQuery(c.env, realmId, "SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 50");
    const items = (itemData.QueryResponse?.Item ?? []) as { Id: string; Name: string }[];
    const roomItem = items.find(i => /room|board|care|resident/i.test(i.Name)) || items[0];

    const results: { name: string; status: string; reason?: string; invoiceId?: string; amount?: number }[] = [];
    for (const r of preview) {
      if (!r.customerId) {
        results.push({ name: r.name, status: 'skipped', reason: 'Customer not found in QuickBooks' });
        continue;
      }
      if (r.alreadyInvoiced) {
        results.push({ name: r.name, status: 'skipped', reason: 'Already invoiced this month' });
        continue;
      }
      try {
        const result = await qbCreate(c.env, realmId, 'invoice', {
          Line: [
            {
              Amount: r.amount,
              DetailType: 'SalesItemLineDetail',
              SalesItemLineDetail: {
                ItemRef: roomItem ? { value: roomItem.Id, name: roomItem.Name } : { value: '1', name: 'Services' },
                Qty: 1,
                UnitPrice: r.amount
              }
            }
          ],
          CustomerRef: { value: r.customerId },
          TxnDate: r.invoiceDate,
          DueDate: r.dueDate
        });
        results.push({ name: r.name, status: 'created', invoiceId: result.Invoice?.Id, amount: r.amount });
      } catch (e) {
        results.push({ name: r.name, status: 'error', reason: e instanceof Error ? sanitizeMessage(e.message) : 'Unknown error' });
      }
    }

    const created = results.filter(r => r.status === 'created');
    const total = created.reduce((sum, r) => sum + (r.amount ?? 0), 0);
    return c.json({ results, created: created.length, total });
  } catch (e) {
    return c.json(handleQboError(e, 'create-invoices'), 500);
  }
});

qboApiRoutes.post('/preview-payment', async c => {
  const realmId = c.get('realmId')!;
  try {
    const { customerName, amount } = (await c.req.json()) as { customerName: string; amount?: number | null };

    const custData = await qbQuery(c.env, realmId, 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
    const customers = (custData.QueryResponse?.Customer ?? []) as QboCustomer[];
    const customer = customers.find(cu => {
      const name = (cu.DisplayName || cu.FullyQualifiedName || '').toLowerCase();
      return name.includes(customerName.toLowerCase()) || customerName.toLowerCase().includes(name);
    });

    if (!customer) return c.json({ found: false, message: `No customer found matching "${customerName}"` });

    const invData = await qbQuery(
      c.env,
      realmId,
      `SELECT * FROM Invoice WHERE CustomerRef = '${customer.Id}' AND Balance > '0' ORDER BY TxnDate DESC MAXRESULTS 1`
    );
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
    return c.json(handleQboError(e, 'preview-payment'), 500);
  }
});

qboApiRoutes.post('/record-payment', requireWriteAccess, async c => {
  const realmId = c.get('realmId')!;
  try {
    const { customerId, invoiceId, paymentAmount, paymentDate } = (await c.req.json()) as {
      customerId: string;
      invoiceId: string;
      paymentAmount: number;
      paymentDate: string;
    };

    const result = await qbCreate(c.env, realmId, 'payment', {
      CustomerRef: { value: customerId },
      TotalAmt: paymentAmount,
      TxnDate: paymentDate,
      Line: [{ Amount: paymentAmount, LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }] }]
    });

    return c.json({ success: true, paymentId: result.Payment?.Id, amount: paymentAmount });
  } catch (e) {
    return c.json(handleQboError(e, 'record-payment'), 500);
  }
});

qboApiRoutes.post('/overdue-summary', async c => {
  const realmId = c.get('realmId')!;
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const data = await qbQuery(c.env, realmId, `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${todayStr}' ORDER BY DueDate ASC MAXRESULTS 100`);
    const invoices = (data.QueryResponse?.Invoice ?? []) as QboInvoice[];

    const items = invoices.map(inv => ({
      customerName: inv.CustomerRef?.name || 'Unknown',
      invoiceNumber: inv.DocNumber,
      dueDate: inv.DueDate,
      daysOverdue: Math.floor((today.getTime() - new Date(inv.DueDate!).getTime()) / (1000 * 60 * 60 * 24)),
      balance: Number(inv.Balance)
    }));

    const total = items.reduce((sum, i) => sum + i.balance, 0);
    return c.json({ items, total, count: items.length });
  } catch (e) {
    return c.json(handleQboError(e, 'overdue-summary'), 500);
  }
});

qboApiRoutes.post('/preview-resident', async c => {
  const realmId = c.get('realmId')!;
  try {
    const { name, paymentType, monthlyRate, moveInDate } = (await c.req.json()) as {
      name: string;
      paymentType: string;
      monthlyRate: number;
      moveInDate: string;
    };

    const custData = await qbQuery(c.env, realmId, 'SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
    const customers = (custData.QueryResponse?.Customer ?? []) as QboCustomer[];
    const duplicate = customers.find(cu => cu.DisplayName?.toLowerCase() === name.toLowerCase());

    return c.json({ name, paymentType, monthlyRate: Number(monthlyRate), moveInDate, isDuplicate: !!duplicate });
  } catch (e) {
    return c.json(handleQboError(e, 'preview-resident'), 500);
  }
});

qboApiRoutes.post('/create-resident', requireWriteAccess, async c => {
  const realmId = c.get('realmId')!;
  try {
    const { name, paymentType, monthlyRate, moveInDate } = (await c.req.json()) as {
      name: string;
      paymentType: string;
      monthlyRate: number;
      moveInDate: string;
    };

    const notes = `Payment type: ${paymentType} | Monthly rate: $${Number(monthlyRate).toLocaleString('en-US', {
      minimumFractionDigits: 2
    })} | Move-in date: ${moveInDate}`;

    const result = await qbCreate(c.env, realmId, 'customer', {
      DisplayName: name,
      PrintOnCheckName: name,
      Notes: notes
    });

    return c.json({ success: true, customerId: result.Customer?.Id, name, monthlyRate: Number(monthlyRate), paymentType, moveInDate });
  } catch (e) {
    return c.json(handleQboError(e, 'create-resident'), 500);
  }
});

// Used by /api/chat's intent detection to pull live customer/rate data.
export { getActiveCustomerNames, getResidentRates };
