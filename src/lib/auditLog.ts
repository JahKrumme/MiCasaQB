import type { Env } from '../env';

export type AuditAction =
  | 'user_invited'
  | 'invitation_resent'
  | 'invitation_revoked'
  | 'user_created'
  | 'role_changed'
  | 'password_reset'
  | 'user_disabled'
  | 'user_reactivated'
  | 'user_removed'
  | 'qbo_connected'
  | 'qbo_reconnected'
  | 'qbo_disconnected'
  // Recorded from the internal Finance routes (src/routes/internal.ts),
  // called by MiCasaCRM (formerly the Hub) — the acting user's email is not
  // a QuickBooks Companion user id, so these use actor: null and put the
  // email in metadata.callerEmail instead. Only real writes are audited
  // here (matching this file's existing discipline) — read/list/prepare
  // routes are not.
  | 'finance_billing_setup_requested'
  | 'finance_followup_resolved'
  | 'finance_customer_created'
  | 'finance_invoice_created'
  | 'finance_payment_recorded'
  | 'finance_invoice_reminder_requested'
  // Integration Health's "Send test email" action (Admin-only, explicit
  // confirmation required — see routes/internal.ts's /gmail/test-send).
  | 'gmail_test_send_succeeded'
  | 'gmail_test_send_failed'
  | 'gmail_signing_link_sent'
  | 'gmail_signing_link_failed'
  // Recorded from the Daily Overdue Check scheduled job (see
  // src/routes/cron.ts, .github/workflows/daily-check.yml) — every real
  // (non-dry-run) invocation records exactly one of these two outcomes so a
  // failed scheduled run is never silent. metadata only ever carries a
  // runId, reminderCount (the number of overdue invoices reported, not a
  // count of emails), and — on failure — a safe errorCategory. Never a
  // customer name, invoice number, or dollar amount.
  | 'scheduled_overdue_check_succeeded'
  | 'scheduled_overdue_check_failed'
  // Same discipline, applied to the other three scheduled financial email
  // jobs (see src/routes/cron.ts, .github/workflows/{30-day-alert,
  // monthly-invoices,kancare-reminder}.yml) — a run id, a record count (0
  // for KanCare's reminder, which has no underlying query), and on
  // failure a safe errorCategory. Never a customer name, invoice number,
  // or dollar amount.
  | 'scheduled_30_day_alert_succeeded'
  | 'scheduled_30_day_alert_failed'
  | 'scheduled_monthly_invoices_succeeded'
  | 'scheduled_monthly_invoices_failed'
  | 'scheduled_kancare_reminder_succeeded'
  | 'scheduled_kancare_reminder_failed';

export interface AuditActor {
  id: string;
  email: string;
}

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: AuditAction;
  target: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

/**
 * Records a single audit event. `metadata` must only ever contain
 * non-sensitive fields (roles, emails, realm ids, counts) — never passwords,
 * hashes, tokens, OAuth codes, or secrets. Callers are responsible for that;
 * this function does no redaction of its own.
 */
export async function recordAuditEvent(
  env: Env,
  params: {
    actor: AuditActor | null;
    action: AuditAction;
    target?: string;
    metadata?: Record<string, unknown>;
  }
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_log (id, actor_user_id, actor_email, action, target, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      crypto.randomUUID(),
      params.actor?.id ?? null,
      params.actor?.email ?? null,
      params.action,
      params.target ?? null,
      params.metadata ? JSON.stringify(params.metadata) : null,
      Date.now()
    )
    .run();
}

interface AuditLogRow {
  id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  target: string | null;
  metadata: string | null;
  created_at: number;
}

function toEntry(row: AuditLogRow): AuditLogEntry {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    actorUserId: row.actor_user_id,
    actorEmail: row.actor_email,
    action: row.action as AuditAction,
    target: row.target,
    metadata,
    createdAt: row.created_at
  };
}

export async function listAuditLog(env: Env, limit = 200): Promise<AuditLogEntry[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<AuditLogRow>();
  return (results ?? []).map(toEntry);
}

// The most recent entry matching any of the given actions — used by
// /internal/health/detailed to surface "what happened on the last
// scheduled run" without the caller needing to fetch/filter the full log.
export async function getLatestAuditEvent(env: Env, actions: AuditAction[]): Promise<AuditLogEntry | null> {
  if (actions.length === 0) return null;
  const placeholders = actions.map(() => '?').join(', ');
  const row = await env.DB.prepare(
    `SELECT * FROM audit_log WHERE action IN (${placeholders}) ORDER BY created_at DESC LIMIT 1`
  ).bind(...actions).first<AuditLogRow>();
  return row ? toEntry(row) : null;
}
