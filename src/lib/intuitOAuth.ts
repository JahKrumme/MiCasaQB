import type { Env } from '../env';

const AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';

// Least-privilege scope: only accounting data, matching what the app has ever used.
const QBO_SCOPE = 'com.intuit.quickbooks.accounting';

export class IntuitOAuthError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'IntuitOAuthError';
  }
}

export interface IntuitTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  x_refresh_token_expires_in?: number;
}

export function buildAuthorizeUrl(env: Env, redirectUri: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', env.INTUIT_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QBO_SCOPE);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}

function basicAuthHeader(env: Env): string {
  const raw = `${env.INTUIT_CLIENT_ID}:${env.INTUIT_CLIENT_SECRET}`;
  // btoa requires a binary string; client id/secret are ASCII per Intuit's format.
  return `Basic ${btoa(raw)}`;
}

/**
 * Extracts only the fields safe to log from a failed Intuit token response —
 * the standard OAuth `error`/`error_description` pair and Intuit's own
 * request-tracing header. Deliberately never surfaces the raw response body:
 * a malformed/non-JSON error page could echo back request parameters (e.g.
 * the authorization code) verbatim.
 */
async function safeErrorDetails(response: Response): Promise<{ error?: string; errorDescription?: string; intuitTid?: string }> {
  const intuitTid = response.headers.get('intuit_tid') ?? undefined;
  try {
    const body = (await response.json()) as { error?: string; error_description?: string };
    return { error: body.error, errorDescription: body.error_description, intuitTid };
  } catch {
    return { intuitTid };
  }
}

/**
 * Temporary diagnostic logging for token-exchange/refresh failures. Logs only
 * shape/metadata — never the client secret, client id, authorization code,
 * tokens, OAuth state, or the Basic auth header itself.
 */
function logTokenFailure(
  env: Env,
  redirectUri: string,
  status: number,
  details: { error?: string; errorDescription?: string; intuitTid?: string }
): void {
  console.error('[QB AUTH FAIL] token request failed', {
    status,
    error: details.error ?? 'unknown',
    errorDescription: details.errorDescription ?? 'none',
    intuitRequestId: details.intuitTid ?? 'none',
    hasClientId: Boolean(env.INTUIT_CLIENT_ID),
    hasClientSecret: Boolean(env.INTUIT_CLIENT_SECRET),
    clientIdLength: env.INTUIT_CLIENT_ID?.length ?? 0,
    clientSecretLength: env.INTUIT_CLIENT_SECRET?.length ?? 0,
    redirectUri
  });
}

async function postToken(env: Env, body: URLSearchParams, redirectUri: string): Promise<IntuitTokenResponse> {
  let response: Response;
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(env),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
  } catch {
    throw new IntuitOAuthError('Network error contacting QuickBooks');
  }

  if (!response.ok) {
    const details = await safeErrorDetails(response);
    logTokenFailure(env, redirectUri, response.status, details);
    throw new IntuitOAuthError('QuickBooks token request failed', details.error, response.status);
  }

  return (await response.json()) as IntuitTokenResponse;
}

export async function exchangeCodeForTokens(env: Env, code: string, redirectUri: string): Promise<IntuitTokenResponse> {
  return postToken(
    env,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri
    }),
    redirectUri
  );
}

export async function refreshAccessToken(env: Env, refreshToken: string): Promise<IntuitTokenResponse> {
  return postToken(
    env,
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }),
    '(refresh_token grant — no redirect_uri)'
  );
}

export function isInvalidGrant(err: unknown): boolean {
  return err instanceof IntuitOAuthError && err.errorCode === 'invalid_grant';
}

export async function revokeToken(env: Env, token: string): Promise<void> {
  try {
    await fetch(REVOKE_URL, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(env),
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token })
    });
  } catch {
    // Best-effort — disconnect should still remove the local record even if
    // Intuit's revoke endpoint is unreachable.
  }
}
