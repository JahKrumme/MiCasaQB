import type { Context } from 'hono';
import type { AppEnv } from '../honoTypes';

/**
 * Resolves the public base URL used to build OAuth redirect URIs. Defaults to
 * the incoming request's own origin so a *.workers.dev URL works out of the
 * box; APP_BASE_URL can pin this once the custom domain is connected.
 */
export function getBaseUrl(c: Context<AppEnv>): string {
  const configured = c.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return new URL(c.req.url).origin;
}

export function isHttpsRequest(c: Context<AppEnv>): boolean {
  return new URL(c.req.url).protocol === 'https:';
}
