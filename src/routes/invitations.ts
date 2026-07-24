import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import type { AppEnv } from '../honoTypes';
import { requireSameOrigin } from '../middleware/security';
import { checkRateLimit } from '../lib/rateLimit';
import { acceptInvitation, getInvitationInfo } from '../lib/invitations';
import { createSession, SESSION_COOKIE } from '../lib/session';
import { isHttpsRequest } from '../lib/baseUrl';
import { recordAuditEvent } from '../lib/auditLog';

// Public — an invited user has no account/session yet. Only reachable with a
// valid single-use token, and rate-limited like the other unauthenticated
// auth endpoints.
export const invitationRoutes = new Hono<AppEnv>();

invitationRoutes.get('/:token', async c => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(c.env, `invite-info:${ip}`, 20, 300);
  if (!allowed) return c.json({ error: 'Too many attempts. Please try again shortly.' }, 429);

  const token = c.req.param('token');
  const result = await getInvitationInfo(c.env, token);
  if (!result.ok) return c.json({ error: 'This invitation link is invalid.' }, 404);
  if (result.expired) return c.json({ error: 'This invitation has expired. Ask an administrator to resend it.' }, 410);

  return c.json({ email: result.email, role: result.role });
});

invitationRoutes.post('/:token/accept', requireSameOrigin, async c => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(c.env, `invite-accept:${ip}`, 10, 300);
  if (!allowed) return c.json({ error: 'Too many attempts. Please try again shortly.' }, 429);

  const token = c.req.param('token');
  let body: { password?: string; confirmPassword?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { password, confirmPassword } = body;
  if (!password || password.length < 12) return c.json({ error: 'Password must be at least 12 characters.' }, 400);
  if (password !== confirmPassword) return c.json({ error: 'Passwords do not match.' }, 400);

  const result = await acceptInvitation(c.env, token, password);
  if (!result.ok) {
    const messages: Record<typeof result.reason, string> = {
      not_found: 'This invitation link is invalid.',
      used: 'This invitation has already been used.',
      expired: 'This invitation has expired. Ask an administrator to resend it.'
    };
    return c.json({ error: messages[result.reason] }, 400);
  }

  await recordAuditEvent(c.env, {
    actor: null,
    action: 'user_created',
    target: result.user.email,
    metadata: { role: result.user.role, via: 'invitation' }
  });

  const { token: sessionToken, expiresAt } = await createSession(c.env, result.user.id);
  setCookie(c, SESSION_COOKIE, sessionToken, {
    httpOnly: true,
    secure: isHttpsRequest(c),
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt)
  });

  return c.json({ authenticated: true, email: result.user.email, role: result.user.role });
});
