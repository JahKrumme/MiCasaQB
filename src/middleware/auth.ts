import { getCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../honoTypes';
import { resolveSession, SESSION_COOKIE } from '../lib/session';
import type { Role } from '../lib/users';

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = await resolveSession(c.env, token);
  if (!user) {
    return c.json({ error: 'Session expired. Please sign in again.' }, 401);
  }
  c.set('user', user);
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user?.isAdmin) {
    return c.json({ error: 'Access denied' }, 403);
  }
  await next();
};

/** Restricts a route to specific roles. Must run after requireAuth. */
export const requireRole = (...roles: Role[]): MiddlewareHandler<AppEnv> => {
  return async (c, next) => {
    const user = c.get('user');
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: 'Access denied' }, 403);
    }
    await next();
  };
};

/**
 * Blocks every route except the auth endpoints needed to clear the flag
 * (login/logout/session/change-password) when an admin has reset this
 * user's password and they haven't set a new one yet. Must run after
 * requireAuth.
 */
export const blockIfPasswordChangeRequired: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (user?.forcePasswordChange) {
    return c.json({ error: 'You must change your password before continuing.', code: 'password_change_required' }, 403);
  }
  await next();
};

export const requireCronSecret: MiddlewareHandler<AppEnv> = async (c, next) => {
  const provided = c.req.header('X-Cron-Secret');
  const expected = c.env.CRON_SECRET;
  if (!expected || !provided || provided !== expected) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  await next();
};
