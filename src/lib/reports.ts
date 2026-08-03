import type { Env } from '../env';
import { qbQuery } from './qboClient';
import { sendEmail } from './gmail';
import { getRecipientEmails } from './users';
import { recordAuditEvent } from './auditLog';

interface QboInvoice {
  DocNumber?: string;
  CustomerRef?: { name?: string };
  DueDate?: string;
  TxnDate?: string;
  Balance?: string | number;
  TotalAmt?: string | number;
}

export type ReportResult =
  | { status: 'no-token' }
  | { status: 'token-error'; message: string }
  | { status: 'ok'; count: number; total?: number; runId?: string; dryRun?: boolean }
  // Gmail (not QuickBooks) failed — the invoice query itself succeeded, but
  // sending the digest email threw. Distinct from 'token-error' (a
  // QuickBooks/Intuit problem) so callers/Integration Health can tell the
  // two apart. errorCategory is a small, closed, safe set — never a raw
  // exception message (see runOverdueCheck below).
  | { status: 'gmail-error'; errorCategory: 'not_configured' | 'auth_failed' | 'send_failed'; runId: string };

function invoiceRows(invoices: QboInvoice[], today: Date, urgencyByDays: boolean): string {
  return invoices
    .map(inv => {
      const due = new Date(inv.DueDate ?? inv.TxnDate ?? today);
      const daysOverdue = Math.floor((today.getTime() - due.getTime()) / (1000 * 60 * 60 * 24));
      const urgency = !urgencyByDays ? '#2c3e50' : daysOverdue > 60 ? '#c0392b' : daysOverdue > 30 ? '#e67e22' : '#2c3e50';
      return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">#${inv.DocNumber}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.CustomerRef?.name || 'N/A'}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.DueDate}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;color:${urgency};font-weight:600">${daysOverdue} days</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">$${Number(inv.Balance).toFixed(2)}</td>
      </tr>`;
    })
    .join('');
}

async function runOverdueQuery(env: Env, realmId: string | null, dueBeforeDate: string): Promise<QboInvoice[] | ReportResult> {
  if (!realmId) return { status: 'no-token' };
  try {
    const data = await qbQuery(env, realmId, `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${dueBeforeDate}'`);
    return (data.QueryResponse?.Invoice ?? []) as QboInvoice[];
  } catch (e) {
    return { status: 'token-error', message: e instanceof Error ? e.message : 'Unknown error' };
  }
}

// `dryRun` computes and returns the real overdue-invoice count/total from a
// real QuickBooks query, but never calls sendEmail — used for safe
// production verification (this repo's own daily-check.yml workflow_dispatch
// input, or a manual check) without risking a real reminder email. A Gmail
// failure here is caught and categorized rather than left to bubble up as an
// unhandled exception (the actual root cause of the 500s this function used
// to produce) — every real (non-dry-run) outcome, success or failure, is
// recorded to the audit log with a runId so a failed scheduled run is never
// silent (see docs/INTEGRATION_HEALTH.md's "Daily Overdue Check" section).
export async function runOverdueCheck(env: Env, realmId: string | null, opts: { dryRun?: boolean } = {}): Promise<ReportResult> {
  const runId = crypto.randomUUID();
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]!;
  const invoicesOrResult = await runOverdueQuery(env, realmId, firstOfMonth);
  if (!Array.isArray(invoicesOrResult)) return invoicesOrResult;

  const invoices = invoicesOrResult;
  if (invoices.length === 0) {
    if (!opts.dryRun) await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_succeeded', metadata: { runId, reminderCount: 0 } });
    return { status: 'ok', count: 0, runId, dryRun: opts.dryRun };
  }

  const totalBalance = invoices.reduce((sum, inv) => sum + Number(inv.Balance), 0);

  if (opts.dryRun) {
    // Never builds/sends the email at all in dry-run mode — nothing here
    // can trigger a real reminder, regardless of how many invoices exist.
    return { status: 'ok', count: invoices.length, total: totalBalance, runId, dryRun: true };
  }

  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Overdue Invoices</h2>
      <p style="color:#555">As of <strong>${today.toISOString().split('T')[0]}</strong> — ${invoices.length} invoice(s) overdue</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead><tr style="background:#f5f5f5">
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Invoice</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Customer</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Due Date</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Days Overdue</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Balance</th>
        </tr></thead>
        <tbody>${invoiceRows(invoices, today, true)}</tbody>
        <tfoot><tr style="background:#fafafa">
          <td colspan="4" style="padding:12px 16px;font-weight:700;text-align:right">Total Outstanding:</td>
          <td style="padding:12px 16px;font-weight:700;color:#c0392b">$${totalBalance.toFixed(2)}</td>
        </tr></tfoot>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuickBooks integration</p>
    </div>`;

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_failed', metadata: { runId, reminderCount: invoices.length, errorCategory: 'not_configured' } });
    return { status: 'gmail-error', errorCategory: 'not_configured', runId };
  }

  try {
    await sendEmail(env, await getRecipientEmails(env), `Overdue Invoices — ${invoices.length} unpaid ($${totalBalance.toFixed(2)})`, html);
  } catch (e) {
    // Same safe categorization convention as routes/internal.ts's
    // /gmail/test-send and /gmail/signing-link — never the raw exception
    // message (could echo an HTTP response body), only a small closed
    // category. This is what used to escape uncaught here and become an
    // opaque 500 with nothing recorded anywhere.
    const message = e instanceof Error ? e.message : '';
    const errorCategory = message.includes('access token') ? 'auth_failed' : 'send_failed';
    console.error('[CRON overdue-check] send failed, runId=', runId, 'category=', errorCategory);
    await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_failed', metadata: { runId, reminderCount: invoices.length, errorCategory } });
    return { status: 'gmail-error', errorCategory, runId };
  }

  await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_succeeded', metadata: { runId, reminderCount: invoices.length } });
  return { status: 'ok', count: invoices.length, total: totalBalance, runId };
}

export async function run30DayAlert(env: Env, realmId: string | null): Promise<ReportResult> {
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 30);
  const invoicesOrResult = await runOverdueQuery(env, realmId, cutoff.toISOString().split('T')[0]!);
  if (!Array.isArray(invoicesOrResult)) return invoicesOrResult;

  const invoices = invoicesOrResult;
  if (invoices.length === 0) return { status: 'ok', count: 0 };

  const totalBalance = invoices.reduce((sum, inv) => sum + Number(inv.Balance), 0);
  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
      <h2 style="color:#c0392b">Action Required: Invoices 30+ Days Overdue</h2>
      <p style="color:#555">As of <strong>${today.toISOString().split('T')[0]}</strong> — ${invoices.length} invoice(s) are more than 30 days past due.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead><tr style="background:#f5f5f5">
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Invoice</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Customer</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Due Date</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Days Overdue</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Balance</th>
        </tr></thead>
        <tbody>${invoiceRows(invoices, today, false)}</tbody>
        <tfoot><tr style="background:#fafafa">
          <td colspan="4" style="padding:12px 16px;font-weight:700;text-align:right">Total Outstanding:</td>
          <td style="padding:12px 16px;font-weight:700;color:#c0392b">$${totalBalance.toFixed(2)}</td>
        </tr></tfoot>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuickBooks integration</p>
    </div>`;

  await sendEmail(env, await getRecipientEmails(env), 'Action Required: Invoices 30+ Days Overdue', html);
  return { status: 'ok', count: invoices.length, total: totalBalance };
}

export async function runMonthlyInvoices(env: Env, realmId: string | null): Promise<ReportResult> {
  if (!realmId) return { status: 'no-token' };
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0]!;
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0]!;
  const nextMonthLabel = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  let invoices: QboInvoice[];
  try {
    const data = await qbQuery(env, realmId, `SELECT * FROM Invoice WHERE TxnDate >= '${firstDay}' AND TxnDate <= '${lastDay}'`);
    invoices = (data.QueryResponse?.Invoice ?? []) as QboInvoice[];
  } catch (e) {
    return { status: 'token-error', message: e instanceof Error ? e.message : 'Unknown error' };
  }

  if (invoices.length === 0) return { status: 'ok', count: 0 };

  const rows = invoices
    .map(
      inv => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">#${inv.DocNumber}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.CustomerRef?.name || 'N/A'}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.TxnDate}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.DueDate || '—'}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">$${Number(inv.TotalAmt).toFixed(2)}</td>
    </tr>`
    )
    .join('');
  const totalAmt = invoices.reduce((sum, inv) => sum + Number(inv.TotalAmt), 0);

  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Mi Casa — Your Invoice for ${nextMonthLabel} is Ready</h2>
      <p style="color:#555">Your invoice for <strong>${nextMonthLabel}</strong> has been prepared. Please review the details below.</p>
      <p style="color:#444">Payment is due on the <strong>1st of ${nextMonthLabel}</strong>. We accept payments through the <strong>5th</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead><tr style="background:#f5f5f5">
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Invoice</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Customer</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Created</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Due Date</th>
          <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Amount</th>
        </tr></thead>
        <tbody>${rows}</tbody>
        <tfoot><tr style="background:#fafafa">
          <td colspan="4" style="padding:12px 16px;font-weight:700;text-align:right">Total Invoiced:</td>
          <td style="padding:12px 16px;font-weight:700;color:#1a1a1a">$${totalAmt.toFixed(2)}</td>
        </tr></tfoot>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuickBooks integration</p>
    </div>`;

  await sendEmail(env, await getRecipientEmails(env), `Mi Casa — Your Invoice for ${nextMonthLabel} is Ready`, html);
  return { status: 'ok', count: invoices.length, total: totalAmt };
}

export async function runKanCareReminder(env: Env): Promise<void> {
  const monthLabel = new Date().toLocaleString('default', { month: 'long', year: 'numeric' });
  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">KanCare Billing Deadline Reminder</h2>
      <p style="color:#444">This is a reminder that <strong>KanCare claims for ${monthLabel} are due soon.</strong></p>
      <p style="color:#444">Please ensure all claims for the current month are submitted before the end of the month to avoid delays in reimbursement.</p>
      <ul style="color:#444;line-height:1.8">
        <li>Review all services rendered in ${monthLabel}</li>
        <li>Verify documentation is complete for each claim</li>
        <li>Submit all claims before the end of the month</li>
      </ul>
      <p style="color:#c0392b;font-weight:600">Deadline: End of ${monthLabel}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuickBooks integration</p>
    </div>`;

  await sendEmail(env, await getRecipientEmails(env), 'KanCare Billing Deadline Reminder', html);
}
