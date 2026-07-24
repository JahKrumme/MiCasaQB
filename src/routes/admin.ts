import { Hono, type Context } from 'hono';
import type { AppEnv } from '../honoTypes';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth';
import { requireSameOrigin } from '../middleware/security';
import { getBaseUrl } from '../lib/baseUrl';
import {
  createUser,
  deleteUser,
  findUserByEmail,
  findUserById,
  isRole,
  listUsers,
  resetUserPassword,
  setUserDisabled,
  setUserRole,
  type Role
} from '../lib/users';
import { generateTemporaryPassword } from '../lib/password';
import {
  createOrRefreshInvitation,
  getInvitationById,
  listPendingInvitations,
  revokeInvitation
} from '../lib/invitations';
import { listAuditLog, recordAuditEvent, type AuditActor } from '../lib/auditLog';
import { sendEmail } from '../lib/gmail';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('*', requireAuth, blockIfPasswordChangeRequired, requireRole('admin'));

function actorFrom(c: Context<AppEnv>): AuditActor {
  const user = c.get('user')!;
  return { id: user.id, email: user.email };
}

async function countActiveAdmins(env: Parameters<typeof listUsers>[0]): Promise<number> {
  const users = await listUsers(env);
  return users.filter(u => u.role === 'admin' && !u.disabled).length;
}

adminRoutes.get('/users', async c => {
  const [users, invitations] = await Promise.all([listUsers(c.env), listPendingInvitations(c.env)]);
  return c.json({
    users: users.map(u => ({
      id: u.id,
      email: u.email,
      role: u.role,
      disabled: u.disabled,
      forcePasswordChange: u.forcePasswordChange,
      createdAt: u.createdAt,
      updatedAt: u.updatedAt
    })),
    invitations
  });
});

adminRoutes.get('/audit-log', async c => {
  return c.json({ entries: await listAuditLog(c.env, 200) });
});

// Sends one email right now, synchronously, via the existing Gmail
// integration — a quick way for an admin to confirm Gmail is actually
// configured and working, independent of invitations or the GitHub
// Actions-triggered report emails.
adminRoutes.post('/send-test-email', requireSameOrigin, async c => {
  const user = c.get('user')!;
  try {
    await sendEmail(
      c.env,
      user.email,
      'Mi Casa QuickBooks Companion — Test Email',
      `<p>This is a test email sent from the Admin panel by ${user.email} at ${new Date().toISOString()}.</p>
       <p>If you received this, Gmail sending is working correctly.</p>`
    );
    return c.json({ success: true });
  } catch (e) {
    console.error('[ADMIN TEST EMAIL FAIL]', e instanceof Error ? e.message : 'unknown');
    return c.json({ error: 'Failed to send test email. Check Gmail secrets are configured.' }, 500);
  }
});

// --- Invitations ---

adminRoutes.post('/invitations', requireSameOrigin, async c => {
  const { email, role } = (await c.req.json()) as { email?: string; role?: string };
  if (!email || !email.includes('@')) return c.json({ error: 'A valid email address is required.' }, 400);
  if (!isRole(role)) return c.json({ error: 'Role must be admin, staff, or read_only.' }, 400);

  const normalizedEmail = email.toLowerCase().trim();
  const existingUser = await findUserByEmail(c.env, normalizedEmail);
  if (existingUser) return c.json({ error: 'A user with that email already exists.' }, 409);

  const result = await createOrRefreshInvitation(c.env, {
    email: normalizedEmail,
    role,
    invitedByUserId: c.get('user')!.id,
    baseUrl: getBaseUrl(c)
  });

  await recordAuditEvent(c.env, {
    actor: actorFrom(c),
    action: result.wasResend ? 'invitation_resent' : 'user_invited',
    target: normalizedEmail,
    metadata: { role }
  });

  return c.json({
    success: true,
    emailSent: result.emailSent,
    // Only ever surfaced when the email failed to send, as a manual fallback.
    inviteUrl: result.emailSent ? undefined : result.inviteUrl
  });
});

adminRoutes.post('/invitations/:id/resend', requireSameOrigin, async c => {
  const id = c.req.param('id');
  const invitation = await getInvitationById(c.env, id);
  if (!invitation) return c.json({ error: 'Invitation not found.' }, 404);

  const result = await createOrRefreshInvitation(c.env, {
    email: invitation.email,
    role: invitation.role,
    invitedByUserId: c.get('user')!.id,
    baseUrl: getBaseUrl(c)
  });

  await recordAuditEvent(c.env, {
    actor: actorFrom(c),
    action: 'invitation_resent',
    target: invitation.email,
    metadata: { role: invitation.role }
  });

  return c.json({ success: true, emailSent: result.emailSent, inviteUrl: result.emailSent ? undefined : result.inviteUrl });
});

adminRoutes.delete('/invitations/:id', requireSameOrigin, async c => {
  const id = c.req.param('id');
  const invitation = await getInvitationById(c.env, id);
  if (!invitation) return c.json({ error: 'Invitation not found.' }, 404);

  await revokeInvitation(c.env, id);
  await recordAuditEvent(c.env, { actor: actorFrom(c), action: 'invitation_revoked', target: invitation.email });
  return c.json({ success: true });
});

// --- Users ---

// Kept for creating an account directly without an email round-trip
// (e.g. a shared device with no inbox access) — still admin-only.
adminRoutes.post('/users', requireSameOrigin, async c => {
  const { email, password, role } = (await c.req.json()) as { email?: string; password?: string; role?: string };

  if (!email || !email.includes('@')) return c.json({ error: 'A valid email address is required.' }, 400);
  if (!password || password.length < 12) return c.json({ error: 'Password must be at least 12 characters.' }, 400);
  if (!isRole(role)) return c.json({ error: 'Role must be admin, staff, or read_only.' }, 400);

  const existing = await findUserByEmail(c.env, email);
  if (existing) return c.json({ error: 'A user with that email already exists.' }, 409);

  const user = await createUser(c.env, email, password, role);
  await recordAuditEvent(c.env, { actor: actorFrom(c), action: 'user_created', target: user.email, metadata: { role } });
  return c.json({ success: true, user: { id: user.id, email: user.email, role: user.role } });
});

adminRoutes.patch('/users/:id/role', requireSameOrigin, async c => {
  const id = c.req.param('id');
  const { role } = (await c.req.json()) as { role?: string };
  if (!isRole(role)) return c.json({ error: 'Role must be admin, staff, or read_only.' }, 400);

  const target = await findUserById(c.env, id);
  if (!target) return c.json({ error: 'User not found.' }, 404);

  if (target.role === 'admin' && role !== 'admin' && (await countActiveAdmins(c.env)) <= 1) {
    return c.json({ error: 'At least one active administrator must remain.' }, 400);
  }

  await setUserRole(c.env, id, role as Role);
  await recordAuditEvent(c.env, {
    actor: actorFrom(c),
    action: 'role_changed',
    target: target.email,
    metadata: { oldRole: target.role, newRole: role }
  });
  return c.json({ success: true });
});

adminRoutes.patch('/users/:id/disable', requireSameOrigin, async c => {
  const id = c.req.param('id');
  const currentUser = c.get('user')!;
  if (id === currentUser.id) return c.json({ error: 'You cannot disable your own account.' }, 400);

  const target = await findUserById(c.env, id);
  if (!target) return c.json({ error: 'User not found.' }, 404);
  if (target.role === 'admin' && (await countActiveAdmins(c.env)) <= 1) {
    return c.json({ error: 'At least one active administrator must remain.' }, 400);
  }

  await setUserDisabled(c.env, id, true);
  await recordAuditEvent(c.env, { actor: actorFrom(c), action: 'user_disabled', target: target.email });
  return c.json({ success: true });
});

adminRoutes.patch('/users/:id/reactivate', requireSameOrigin, async c => {
  const id = c.req.param('id');
  const target = await findUserById(c.env, id);
  if (!target) return c.json({ error: 'User not found.' }, 404);

  await setUserDisabled(c.env, id, false);
  await recordAuditEvent(c.env, { actor: actorFrom(c), action: 'user_reactivated', target: target.email });
  return c.json({ success: true });
});

adminRoutes.post('/users/:id/reset-password', requireSameOrigin, async c => {
  const id = c.req.param('id');
  const target = await findUserById(c.env, id);
  if (!target) return c.json({ error: 'User not found.' }, 404);

  const temporaryPassword = generateTemporaryPassword();
  await resetUserPassword(c.env, id, temporaryPassword);
  await recordAuditEvent(c.env, { actor: actorFrom(c), action: 'password_reset', target: target.email });

  // Shown once, directly to the requesting admin over their own authenticated
  // session — never logged, never stored, never sent anywhere else.
  return c.json({ success: true, temporaryPassword });
});

adminRoutes.delete('/users/:id', requireSameOrigin, async c => {
  const id = c.req.param('id');
  const currentUser = c.get('user')!;
  if (id === currentUser.id) return c.json({ error: 'You cannot remove your own account.' }, 400);

  const target = await findUserById(c.env, id);
  if (!target) return c.json({ error: 'User not found.' }, 404);
  if (target.role === 'admin' && (await countActiveAdmins(c.env)) <= 1) {
    return c.json({ error: 'At least one active administrator must remain.' }, 400);
  }

  await deleteUser(c.env, id);
  await recordAuditEvent(c.env, { actor: actorFrom(c), action: 'user_removed', target: target.email });
  return c.json({ success: true });
});
