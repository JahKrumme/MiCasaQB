import type { Env } from '../env';
import { randomToken, sha256Hex } from './crypto';
import { sendEmail } from './gmail';
import { createUser, type Role, type User } from './users';

const INVITATION_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

export interface InvitationSummary {
  id: string;
  email: string;
  role: Role;
  invitedBy: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'expired';
}

interface InvitationRow {
  id: string;
  email: string;
  role: string;
  token_hash: string;
  invited_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

function inviteEmailHtml(role: Role, inviteUrl: string): string {
  const roleLabel = { admin: 'Administrator', staff: 'Staff', read_only: 'Read Only' }[role];
  return `
    <p>You've been invited to the Mi Casa QuickBooks Companion as <strong>${roleLabel}</strong>.</p>
    <p><a href="${inviteUrl}">Accept your invitation and set a password</a></p>
    <p>This link expires in 48 hours and can only be used once.</p>
    <p>If you weren't expecting this invitation, you can ignore this email.</p>
  `;
}

/**
 * Creates a new invitation, or refreshes (new token + expiry, same row) an
 * existing unused one for the same email — so re-inviting/resending never
 * creates duplicate pending rows. Only the raw token ever leaves this
 * function (in the emailed link, or the return value as a manual fallback
 * when email sending fails) — D1 only ever stores its SHA-256 hash.
 */
export async function createOrRefreshInvitation(
  env: Env,
  params: { email: string; role: Role; invitedByUserId: string; baseUrl: string }
): Promise<{ id: string; inviteUrl: string; emailSent: boolean; wasResend: boolean }> {
  const normalizedEmail = params.email.toLowerCase().trim();
  const rawToken = randomToken(32);
  const tokenHash = await sha256Hex(rawToken);
  const now = Date.now();
  const expiresAt = now + INVITATION_TTL_MS;

  const existing = await env.DB.prepare(`SELECT id FROM invitations WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1`)
    .bind(normalizedEmail)
    .first<{ id: string }>();

  let id: string;
  if (existing) {
    id = existing.id;
    await env.DB.prepare(
      `UPDATE invitations SET role = ?, token_hash = ?, invited_by = ?, created_at = ?, expires_at = ? WHERE id = ?`
    )
      .bind(params.role, tokenHash, params.invitedByUserId, now, expiresAt, id)
      .run();
  } else {
    id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO invitations (id, email, role, token_hash, invited_by, created_at, expires_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`
    )
      .bind(id, normalizedEmail, params.role, tokenHash, params.invitedByUserId, now, expiresAt)
      .run();
  }

  const inviteUrl = `${params.baseUrl.replace(/\/+$/, '')}/invite.html?token=${rawToken}`;

  let emailSent = true;
  try {
    await sendEmail(env, normalizedEmail, 'You are invited to the Mi Casa QuickBooks Companion', inviteEmailHtml(params.role, inviteUrl));
  } catch {
    emailSent = false;
  }

  return { id, inviteUrl, emailSent, wasResend: !!existing };
}

export async function getInvitationById(env: Env, id: string): Promise<InvitationSummary | null> {
  const row = await env.DB.prepare(`SELECT * FROM invitations WHERE id = ? AND used_at IS NULL`).bind(id).first<InvitationRow>();
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    role: row.role as Role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.expires_at < Date.now() ? 'expired' : 'pending'
  };
}

export type InvitationInfoResult =
  | { ok: true; email: string; role: Role; expired: boolean }
  | { ok: false; reason: 'not_found' | 'used' };

export async function getInvitationInfo(env: Env, rawToken: string): Promise<InvitationInfoResult> {
  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare(`SELECT * FROM invitations WHERE token_hash = ?`).bind(tokenHash).first<InvitationRow>();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.used_at != null) return { ok: false, reason: 'used' };
  return { ok: true, email: row.email, role: row.role as Role, expired: row.expires_at < Date.now() };
}

export type AcceptInvitationResult = { ok: true; user: User } | { ok: false; reason: 'not_found' | 'used' | 'expired' };

/**
 * Atomically claims the invitation (UPDATE ... WHERE used_at IS NULL) before
 * creating the account, so two concurrent accept requests for the same token
 * can never both succeed — the loser sees `reason: 'used'`.
 */
export async function acceptInvitation(env: Env, rawToken: string, password: string): Promise<AcceptInvitationResult> {
  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare(`SELECT * FROM invitations WHERE token_hash = ?`).bind(tokenHash).first<InvitationRow>();
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.used_at != null) return { ok: false, reason: 'used' };
  if (row.expires_at < Date.now()) return { ok: false, reason: 'expired' };

  const claim = await env.DB.prepare(`UPDATE invitations SET used_at = ? WHERE id = ? AND used_at IS NULL`)
    .bind(Date.now(), row.id)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return { ok: false, reason: 'used' };

  const user = await createUser(env, row.email, password, row.role as Role);
  return { ok: true, user };
}

export async function listPendingInvitations(env: Env): Promise<InvitationSummary[]> {
  const { results } = await env.DB.prepare(`SELECT * FROM invitations WHERE used_at IS NULL ORDER BY created_at DESC`).all<InvitationRow>();
  const now = Date.now();
  return (results ?? []).map(row => ({
    id: row.id,
    email: row.email,
    role: row.role as Role,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.expires_at < now ? 'expired' : 'pending'
  }));
}

export async function revokeInvitation(env: Env, id: string): Promise<void> {
  await env.DB.prepare(`DELETE FROM invitations WHERE id = ? AND used_at IS NULL`).bind(id).run();
}
