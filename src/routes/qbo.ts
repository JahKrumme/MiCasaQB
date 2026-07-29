import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
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

// The CRM-initiated branch: MiCasaCRM's POST /internal/oauth/authorize-url
// mints a state row keyed 'svc:<crm-user-email>' instead of a QuikBooks
// staff user id (see src/routes/internal.ts) — there is no QuikBooks
// session/cookie for that flow, since the CRM's own admin-only permission
// check already ran before that state was minted. The trust boundary is the
// state value itself: single-use, 10-minute TTL, only ever mintable by a
// caller who already passed finance.oauth.connect.
//
// This middleware runs BEFORE requireAuth/requireRole('admin') below and
// either fully handles the CRM-initiated redirect itself (never calling
// next(), so the staff-session checks after it never run for this request),
// or calls next() to fall through to the unchanged staff flow when the
// state isn't 'svc:'-prefixed (covers a missing/foreign/malformed state
// too — the ordinary staff handler's own validateAndConsumeOAuthState
// rejects those exactly as it always has).
// Safe diagnostic logging only — every line here is reviewed against the
// same rule: never log the authorization code, access/refresh tokens,
// client secret, or encryption key. Shape/presence/outcome only.
function logCallback(event: string, details?: Record<string, unknown>): void {
  console.log('[QB OAUTH CALLBACK]', event, details ?? {});
}

const routeCrmInitiatedCallback: MiddlewareHandler<AppEnv> = async (c, next) => {
  logCallback('callback_reached');

  const callbackState = c.req.query('state');
  logCallback('state_present', { present: Boolean(callbackState) });

  const stateRow = callbackState
    ? await c.env.DB.prepare(`SELECT user_id FROM oauth_state WHERE state = ?`).bind(callbackState).first<{ user_id: string }>()
    : null;

  if (!stateRow?.user_id.startsWith('svc:')) {
    // Not a CRM-initiated state (missing, unknown, or a staff-flow state) —
    // fall through unchanged to the ordinary staff-session callback below,
    // which performs its own full validation and rejects appropriately.
    logCallback('not_crm_initiated_falling_through');
    return next();
  }

  const stateUserId = stateRow.user_id;
  const code = c.req.query('code');
  const realmId = c.req.query('realmId');
  // CRM_BASE_URL is server-side configuration, never a caller-supplied
  // value — there is no query parameter or header that can influence where
  // this redirects. An arbitrary "return URL" is not accepted from the
  // request at all.
  const crmBaseUrl = (c.env.CRM_BASE_URL || '').replace(/\/+$/, '');
  const redirectBase = crmBaseUrl ? `${crmBaseUrl}/finance.html` : '/index.html';

  const stateResult = await validateAndConsumeOAuthState(c.env, callbackState, callbackState, stateUserId);
  logCallback('state_validation', { valid: stateResult.ok, reason: stateResult.ok ? undefined : stateResult.reason });
  if (!stateResult.ok) {
    return c.redirect(`${redirectBase}?qbo=error&reason=state_${stateResult.reason}`, 302);
  }

  logCallback('realm_id_present', { present: Boolean(realmId) });
  if (!code || !realmId) {
    return c.redirect(`${redirectBase}?qbo=error&reason=missing_params`, 302);
  }

  const repo = new TokenRepository(c.env);
  const hadExistingConnection = (await repo.getActiveRealmId()) != null;

  try {
    await connectNewRealm(c.env, code, realmId, callbackUrl(getBaseUrl(c)));
    logCallback('token_exchange_status', { ok: true });
  } catch (e) {
    logCallback('token_exchange_status', { ok: false, message: e instanceof Error ? e.message : 'unknown' });
    return c.redirect(`${redirectBase}?qbo=error&reason=exchange_failed`, 302);
  }

  logCallback('tokens_stored');

  await recordAuditEvent(c.env, {
    actor: null,
    action: hadExistingConnection ? 'qbo_reconnected' : 'qbo_connected',
    target: realmId,
    metadata: { callerEmail: stateUserId.slice('svc:'.length) }
  });

  return c.redirect(`${redirectBase}?qbo=connected`, 302);
};

qboRoutes.get('/callback', routeCrmInitiatedCallback, requireAuth, blockIfPasswordChangeRequired, requireRole('admin'), async c => {
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
