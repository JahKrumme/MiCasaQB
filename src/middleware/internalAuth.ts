import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../honoTypes';
import { verifyServiceAssertion } from '../lib/serviceAssertion';

const ASSERTION_HEADER = 'X-Service-Assertion';

/**
 * Verifies the Hub's signed service assertion on every /internal/* route.
 * This is the ENTIRE authorization boundary for those routes — they carry
 * no staff session cookie, since the caller is the Hub Worker itself (via
 * the FINANCE Service Binding), acting on behalf of whichever Hub user made
 * the original request. Rejects a missing/invalid/expired assertion, and
 * separately rejects a replayed jti even within the assertion's own validity
 * window (an assertion is meant to be used exactly once).
 */
export const requireServiceAssertion: MiddlewareHandler<AppEnv> = async (c, next) => {
  const secret = c.env.FINANCE_INTERNAL_SECRET;
  if (!secret) {
    console.error('FINANCE_INTERNAL_SECRET is not configured');
    return c.json({ error: 'Internal integration is not configured' }, 503);
  }

  const token = c.req.header(ASSERTION_HEADER);
  const payload = token ? await verifyServiceAssertion(secret, token) : null;
  if (!payload) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Opportunistic cleanup — plain integer comparison, no timestamp-format
  // mismatch risk (unlike a TEXT datetime() comparison; see the CRM's
  // hub_internal_nonces bug this was written to avoid repeating).
  await c.env.DB.prepare(`DELETE FROM internal_assertion_jti WHERE expires_at < ?`).bind(Date.now()).run();

  try {
    await c.env.DB.prepare(`INSERT INTO internal_assertion_jti (jti, expires_at) VALUES (?, ?)`).bind(payload.jti, payload.exp).run();
  } catch {
    // UNIQUE constraint violation — this exact assertion was already used.
    return c.json({ error: 'Assertion already used (replay detected)' }, 401);
  }

  c.set('serviceAssertion', payload);
  await next();
};

/** Must run after requireServiceAssertion. Rejects unless the verified assertion's permission list includes `permission`. */
export function requireServicePermission(permission: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const assertion = c.get('serviceAssertion');
    if (!assertion || !assertion.permissions.includes(permission)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    await next();
  };
}
