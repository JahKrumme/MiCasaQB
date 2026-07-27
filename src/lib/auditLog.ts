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
  // Recorded from the Hub's Finance internal routes (src/routes/internal.ts)
  // — the acting Hub user's email is not a QuickBooks Companion user id, so
  // these use actor: null and put the email in metadata.hubUserEmail instead.
  | 'finance_billing_setup_requested'
  | 'finance_followup_resolved';

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
