import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../honoTypes';

/**
 * Global security headers. CSP is intentionally strict (no 'unsafe-inline'):
 * the frontend ships its CSS/JS as external files specifically so this policy
 * can stay tight.
 */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests'
    ].join('; ')
  );
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  c.res.headers.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  c.res.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  c.res.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
};

/**
 * Defense-in-depth CSRF check for state-changing requests: same-origin
 * fetches always send Origin, and SameSite=Lax cookies already stop the
 * browser from attaching session cookies to cross-site fetch/XHR — this just
 * rejects the rare case Origin is present but wrong.
 */
export const requireSameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const origin = c.req.header('Origin');
  if (origin) {
    const requestOrigin = new URL(c.req.url).origin;
    if (origin !== requestOrigin) {
      return c.json({ error: 'Cross-origin request rejected' }, 403);
    }
  }
  await next();
};
