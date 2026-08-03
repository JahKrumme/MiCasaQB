import type { Env } from '../env';
import { qbQuery } from './qboClient';
import { sendEmail, verifyGmailAuth, diagnoseGmailSend, GmailAuthError, type GmailSendDiagnostic } from './gmail';
import { getRecipientEmails } from './users';
import { recordAuditEvent } from './auditLog';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  | { status: 'ok'; count: number; total?: number; runId?: string; dryRun?: boolean; gmailAuthOk?: boolean; gmailAuthErrorCategory?: 'not_configured' | 'auth_failed' }
  // Gmail (not QuickBooks) failed — the invoice query itself succeeded, but
  // sending the digest email threw. Distinct from 'token-error' (a
  // QuickBooks/Intuit problem) so callers/Integration Health can tell the
  // two apart. errorCategory is a small, closed, safe set derived from
  // GmailAuthError's own category (never a raw exception message or
  // response body) — 'invalid_grant' means the refresh token itself is
  // rejected, 'rate_limited'/'transient' mean Google's token endpoint is
  // temporarily unhappy (worth retrying later, not a broken credential),
  // 'send_failed' means auth succeeded but the actual message send was
  // rejected.
  | { status: 'gmail-error'; errorCategory: 'not_configured' | 'invalid_client' | 'invalid_grant' | 'rate_limited' | 'transient' | 'unknown_auth_error' | 'send_failed'; runId: string };

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

// Single source of truth for the overdue-digest email's subject/body — used
// by both the real send (runOverdueCheck) and the diagnostic path
// (diagnoseOverdueDigest) so the diagnostic is never a re-implementation
// that could quietly drift from what's actually sent.
function buildOverdueDigestEmail(invoices: QboInvoice[], today: Date, totalBalance: number): { subject: string; html: string } {
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
  return { subject: `Overdue Invoices — ${invoices.length} unpaid ($${totalBalance.toFixed(2)})`, html };
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

  // A dry run also verifies Gmail credentials via a real token-refresh-only
  // call (verifyGmailAuth() — never sends anything) so a single safe call
  // answers both "are there overdue invoices" and "would sending actually
  // work right now" without ever risking a real reminder email.
  const gmailAuth = opts.dryRun ? await verifyGmailAuth(env) : null;

  if (invoices.length === 0) {
    if (!opts.dryRun) {
      await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_succeeded', metadata: { runId, reminderCount: 0 } }).catch(auditErr => {
        console.error('[CRON overdue-check] failed to record success audit event, runId=', runId, auditErr instanceof Error ? auditErr.message : 'unknown');
      });
    }
    return {
      status: 'ok', count: 0, runId, dryRun: opts.dryRun,
      ...(gmailAuth ? { gmailAuthOk: gmailAuth.ok, gmailAuthErrorCategory: gmailAuth.ok ? undefined : gmailAuth.errorCategory } : {})
    };
  }

  const totalBalance = invoices.reduce((sum, inv) => sum + Number(inv.Balance), 0);

  if (opts.dryRun) {
    // Never builds/sends the email at all in dry-run mode — nothing here
    // can trigger a real reminder, regardless of how many invoices exist.
    return {
      status: 'ok', count: invoices.length, total: totalBalance, runId, dryRun: true,
      gmailAuthOk: gmailAuth!.ok, gmailAuthErrorCategory: gmailAuth!.ok ? undefined : gmailAuth!.errorCategory
    };
  }

  const { subject, html } = buildOverdueDigestEmail(invoices, today, totalBalance);

  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_failed', metadata: { runId, reminderCount: invoices.length, errorCategory: 'not_configured' } });
    return { status: 'gmail-error', errorCategory: 'not_configured', runId };
  }

  try {
    await sendEmail(env, await getRecipientEmails(env), subject, html);
  } catch (e) {
    // Derived from GmailAuthError's own structured category — never a
    // fragile substring match against the exception message (which broke
    // down as soon as the message text needed to change) and never the raw
    // exception message or a response body itself. This is what used to
    // escape uncaught here and become an opaque 500 with nothing recorded
    // anywhere.
    const errorCategory = e instanceof GmailAuthError ? e.category : 'send_failed';
    console.error('[CRON overdue-check] send failed, runId=', runId, 'category=', errorCategory);
    // Audit logging failure here must never surface as this request's own
    // failure — a non-2xx response after a real (possibly already-sent)
    // email would make GitHub Actions retry the whole request, which could
    // trigger a real duplicate send. Best-effort only.
    await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_failed', metadata: { runId, reminderCount: invoices.length, errorCategory } }).catch(auditErr => {
      console.error('[CRON overdue-check] failed to record failure audit event, runId=', runId, auditErr instanceof Error ? auditErr.message : 'unknown');
    });
    return { status: 'gmail-error', errorCategory, runId };
  }

  // The email has already been sent successfully at this point — audit
  // logging must never turn a real, successful send into a reported
  // failure (which would make GitHub Actions retry and risk a real
  // duplicate send). Best-effort only.
  await recordAuditEvent(env, { actor: null, action: 'scheduled_overdue_check_succeeded', metadata: { runId, reminderCount: invoices.length } }).catch(auditErr => {
    console.error('[CRON overdue-check] failed to record success audit event, runId=', runId, auditErr instanceof Error ? auditErr.message : 'unknown');
  });
  return { status: 'ok', count: invoices.length, total: totalBalance, runId };
}

export type OverdueDigestDiagnosticPhase = 'quickbooks_query' | 'recipients' | 'message_build' | 'gmail_auth' | 'ready';
export type OverdueDigestDiagnosticCategory =
  | 'no_token' | 'quickbooks_query_failed' // quickbooks_query phase
  | 'recipient_invalid' // recipients phase
  | 'message_build_failed' // message_build phase
  | 'not_configured' | 'invalid_client' | 'invalid_grant' | 'rate_limited' | 'transient' | 'unknown_auth_error'; // gmail_auth phase

export interface OverdueDigestDiagnostic {
  ok: boolean;
  phase: OverdueDigestDiagnosticPhase;
  category: OverdueDigestDiagnosticCategory | null;
  invoiceCount: number;
  hasRecipients: boolean;
  gmailAuthOk: boolean;
  messageBuilt: boolean;
}

// Exercises the REAL send path end to end — real QuickBooks query, the
// exact real digest payload (buildOverdueDigestEmail, the same function the
// real send uses), real recipient validation, and a real Gmail token
// refresh (never a send) — and stops immediately before the network call
// that would actually deliver the email. Never calls sendEmail/SEND_URL
// under any outcome. See src/routes/cron.ts's `?diagnostic=true`.
export async function diagnoseOverdueDigest(env: Env, realmId: string | null): Promise<OverdueDigestDiagnostic> {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]!;
  const invoicesOrResult = await runOverdueQuery(env, realmId, firstOfMonth);
  if (!Array.isArray(invoicesOrResult)) {
    const category = invoicesOrResult.status === 'no-token' ? 'no_token' : 'quickbooks_query_failed';
    return { ok: false, phase: 'quickbooks_query', category, invoiceCount: 0, hasRecipients: false, gmailAuthOk: false, messageBuilt: false };
  }
  const invoices = invoicesOrResult;
  const totalBalance = invoices.reduce((sum, inv) => sum + Number(inv.Balance), 0);

  const recipients = await getRecipientEmails(env);
  const recipientList = recipients.split(',').map(r => r.trim()).filter(Boolean);
  const hasRecipients = recipientList.length > 0 && recipientList.every(r => EMAIL_RE.test(r));
  if (!hasRecipients) {
    return { ok: false, phase: 'recipients', category: 'recipient_invalid', invoiceCount: invoices.length, hasRecipients: false, gmailAuthOk: false, messageBuilt: false };
  }

  // The exact same subject/html the real send would build — never a
  // separately-maintained diagnostic version that could quietly drift.
  const { subject, html } = buildOverdueDigestEmail(invoices, today, totalBalance);

  const gmailDiag: GmailSendDiagnostic = await diagnoseGmailSend(env, recipients, subject, html);
  if (!gmailDiag.ok) {
    return {
      ok: false,
      phase: gmailDiag.phase === 'message_build' ? 'message_build' : 'gmail_auth',
      category: gmailDiag.category,
      invoiceCount: invoices.length, hasRecipients: true,
      gmailAuthOk: gmailDiag.gmailAuthOk, messageBuilt: gmailDiag.messageBuilt
    };
  }

  return { ok: true, phase: 'ready', category: null, invoiceCount: invoices.length, hasRecipients: true, gmailAuthOk: true, messageBuilt: true };
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
