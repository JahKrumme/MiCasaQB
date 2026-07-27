import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../honoTypes';
import { requireAuth } from '../middleware/auth';
import { requireSameOrigin } from '../middleware/security';
import { checkRateLimit } from '../lib/rateLimit';
import { createSession, destroySession, resolveSession, SESSION_COOKIE } from '../lib/session';
import { changeOwnPassword, isThemePreference, setThemePreference, verifyCredentials } from '../lib/users';
import { isHttpsRequest } from '../lib/baseUrl';

export const authRoutes = new Hono<AppEnv>();

authRoutes.post('/login', requireSameOrigin, async c => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(c.env, `login:${ip}`, 10, 300);
  if (!allowed) {
    return c.json({ error: 'Too many sign-in attempts. Please try again in a few minutes.' }, 429);
  }

  let body: { email?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const email = body.email?.trim();
  const password = body.password;
  if (!email || !password) {
    return c.json({ error: 'Email and password are required.' }, 400);
  }

  const user = await verifyCredentials(c.env, email, password);
  if (!user) {
    return c.json({ error: 'Incorrect email or password.' }, 401);
  }

  const { token, expiresAt } = await createSession(c.env, user.id);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttpsRequest(c),
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt)
  });

  return c.json({
    authenticated: true,
    email: user.email,
    isAdmin: user.isAdmin,
    role: user.role,
    forcePasswordChange: user.forcePasswordChange,
    themePreference: user.themePreference
  });
});

authRoutes.post('/logout', async c => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await destroySession(c.env, token);
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ success: true });
});

authRoutes.get('/session', async c => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = await resolveSession(c.env, token);
  if (!user) return c.json({ authenticated: false });
  return c.json({
    authenticated: true,
    email: user.email,
    isAdmin: user.isAdmin,
    role: user.role,
    forcePasswordChange: user.forcePasswordChange,
    themePreference: user.themePreference
  });
});

// Self-service Appearance preference — any authenticated user (not just
// admins) sets their own theme. D1 is the durable cross-device value; the
// client mirrors it into localStorage for the pre-paint theme script.
authRoutes.put('/theme', requireAuth, requireSameOrigin, async c => {
  const user = c.get('user')!;

  let body: { theme?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  if (!isThemePreference(body.theme)) {
    return c.json({ error: 'theme must be one of: system, light, dark' }, 400);
  }

  await setThemePreference(c.env, user.id, body.theme);
  return c.json({ success: true, theme: body.theme });
});

// Kept for symmetry with requireAuth-protected routes; not currently used by
// the frontend but useful for verifying a session server-side elsewhere.
authRoutes.get('/whoami', requireAuth, async c => {
  const user = c.get('user')!;
  return c.json({ email: user.email, isAdmin: user.isAdmin, role: user.role });
});

// Reachable even when forcePasswordChange is set (it's the only way to clear
// it) — requires the current password so a hijacked session alone isn't
// enough to lock out the real owner.
authRoutes.post('/change-password', requireAuth, requireSameOrigin, async c => {
  const user = c.get('user')!;

  let body: { currentPassword?: string; newPassword?: string; confirmPassword?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid request body' }, 400);
  }

  const { currentPassword, newPassword, confirmPassword } = body;
  if (!currentPassword || !newPassword) {
    return c.json({ error: 'Current and new password are required.' }, 400);
  }
  if (newPassword.length < 12) {
    return c.json({ error: 'New password must be at least 12 characters.' }, 400);
  }
  if (newPassword !== confirmPassword) {
    return c.json({ error: 'New passwords do not match.' }, 400);
  }

  const verified = await verifyCredentials(c.env, user.email, currentPassword);
  if (!verified) {
    return c.json({ error: 'Current password is incorrect.' }, 401);
  }

  await changeOwnPassword(c.env, user.id, newPassword);
  return c.json({ success: true });
});
