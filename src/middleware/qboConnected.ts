import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../honoTypes';
import { TokenRepository } from '../lib/tokenRepository';

export const requireQboConnected: MiddlewareHandler<AppEnv> = async (c, next) => {
  const repo = new TokenRepository(c.env);
  const realmId = await repo.getActiveRealmId();
  if (!realmId) {
    return c.json({ error: 'QuickBooks is not connected.', reconnect: '/api/qbo/connect' }, 503);
  }
  c.set('realmId', realmId);
  await next();
};
