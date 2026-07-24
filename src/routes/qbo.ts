import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../honoTypes';
import { requireAuth, requireRole, blockIfPasswordChangeRequired } from '../middleware/auth';
import { getBaseUrl, isHttpsRequest } from '../lib/baseUrl';
import { buildAuthorizeUrl } from '../lib/intuitOAuth';
import { createOAuthState, validateAndConsumeOAuthState } from '../lib/oauthState';
import { connectNewRealm, disconnectRealm, QboNotConnectedError } from '../lib/qboClient';
import { TokenRepository } from '../lib/tokenRepository';
import { checkRateLimit } from '../lib/rateLimit';
import { recordAuditEvent } from '../lib/auditLog';

export const qboRoutes = new Hono<AppEnv>();

const OAUTH_STATE_COOKIE = 'qbo_oauth_state';

function callbackUrl(baseUrl: string): string {
  return `${baseUrl}/api/qbo/callback`;
}

qboRoutes.get('/connect', requireAuth, blockIfPasswordChangeRequired, requireRole('admin'), async c => {
  const ip = c.req.header('CF-Connecting-IP') ?? 'unknown';
  const allowed = await checkRateLimit(c.env, `qbo-connect:${ip}`, 10, 300);
  if (!allowed) return c.json({ error: 'Too many attempts. Please try again shortly.' }, 429);

  const user = c.get('user')!;
  const state = await createOAuthState(c.env, user.id);

  setCookie(c, OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: isHttpsRequest(c),
    sameSite: 'Lax',
    path: '/',
    maxAge: 600
  });

  const authorizeUrl = buildAuthorizeUrl(c.env, callbackUrl(getBaseUrl(c)), state);
  return c.redirect(authorizeUrl, 302);
});

qboRoutes.get('/callback', requireAuth, blockIfPasswordChangeRequired, requireRole('admin'), async c => {
  const user = c.get('user')!;
  const cookieState = getCookie(c, OAUTH_STATE_COOKIE);
  const callbackState = c.req.query('state');
  const code = c.req.query('code');
  const realmId = c.req.query('realmId');

  const stateResult = await validateAndConsumeOAuthState(c.env, cookieState, callbackState, user.id);
  deleteCookie(c, OAUTH_STATE_COOKIE, { path: '/' });

  if (!stateResult.ok) {
    console.error('[QB AUTH FAIL] oauth state rejected:', stateResult.reason);
    return c.redirect(`/index.html?qbo=error&reason=state_${stateResult.reason}`, 302);
  }

  if (!code || !realmId) {
    return c.redirect('/index.html?qbo=error&reason=missing_params', 302);
  }

  const repo = new TokenRepository(c.env);
  const hadExistingConnection = (await repo.getActiveRealmId()) != null;

  try {
    await connectNewRealm(c.env, code, realmId, callbackUrl(getBaseUrl(c)));
  } catch (e) {
    console.error('[QB AUTH FAIL] token exchange failed:', e instanceof Error ? e.message : 'unknown');
    return c.redirect('/index.html?qbo=error&reason=exchange_failed', 302);
  }

  await recordAuditEvent(c.env, {
    actor: { id: user.id, email: user.email },
    action: hadExistingConnection ? 'qbo_reconnected' : 'qbo_connected',
    target: realmId
  });

  return c.redirect('/index.html?qbo=connected', 302);
});

qboRoutes.get('/status', requireAuth, blockIfPasswordChangeRequired, async c => {
  const repo = new TokenRepository(c.env);
  const realmId = await repo.getActiveRealmId();
  if (!realmId) return c.json({ connected: false });

  const connection = await repo.getConnection(realmId);
  if (!connection) return c.json({ connected: false });

  // Deliberately only ever return metadata — never token fields.
  return c.json({
    connected: true,
    realmId: connection.realmId,
    environment: c.env.INTUIT_ENVIRONMENT,
    accessTokenExpiresAt: connection.bundle.access_token_expires_at,
    refreshTokenExpiresAt: connection.bundle.refresh_token_expires_at
  });
});

qboRoutes.post('/disconnect', requireAuth, blockIfPasswordChangeRequired, requireRole('admin'), async c => {
  const user = c.get('user')!;
  const repo = new TokenRepository(c.env);
  const realmId = await repo.getActiveRealmId();
  if (!realmId) return c.json({ success: true, message: 'Already disconnected.' });

  try {
    await disconnectRealm(c.env, realmId);
  } catch (e) {
    if (!(e instanceof QboNotConnectedError)) {
      console.error('[QB AUTH FAIL] disconnect error:', e instanceof Error ? e.message : 'unknown');
      return c.json({ error: 'Failed to disconnect QuickBooks.' }, 500);
    }
  }

  await recordAuditEvent(c.env, { actor: { id: user.id, email: user.email }, action: 'qbo_disconnected', target: realmId });
  return c.json({ success: true });
});
