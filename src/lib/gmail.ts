import type { Env } from '../env';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

// A small, closed set of safe categories for a Gmail auth failure — never a
// raw exception message or response body. `code` (when present) is Google's
// own short OAuth error string (e.g. "invalid_grant", "rate_limit_exceeded")
// — these are defined, non-secret, spec-level error identifiers (see
// https://www.rfc-editor.org/rfc/rfc6749#section-5.2), safe to log/audit;
// `error_description` (which can occasionally be more verbose) is
// deliberately never captured here.
export type GmailAuthErrorCategory = 'not_configured' | 'invalid_grant' | 'rate_limited' | 'transient' | 'unknown_auth_error';

export class GmailAuthError extends Error {
  category: GmailAuthErrorCategory;
  httpStatus: number | null;
  constructor(category: GmailAuthErrorCategory, httpStatus: number | null, message: string) {
    super(message);
    this.name = 'GmailAuthError';
    this.category = category;
    this.httpStatus = httpStatus;
  }
}

// Maps Google's own OAuth error codes (RFC 6749 §5.2 + Google's own
// rate-limit code) to our closed category set. Any code we don't recognize
// still gets a real, safe category ('unknown_auth_error') rather than being
// silently collapsed into a generic string — this is what previously made
// runOverdueCheck's categorization depend on fragile substring-matching a
// hardcoded message rather than a real, structured failure reason.
function categorizeGoogleError(status: number, errorCode: string | null): GmailAuthErrorCategory {
  if (errorCode === 'invalid_grant') return 'invalid_grant'; // refresh token itself is invalid/revoked/expired
  if (errorCode === 'rate_limit_exceeded' || status === 429) return 'rate_limited';
  if (status >= 500) return 'transient';
  return 'unknown_auth_error';
}

async function getAccessToken(env: Env): Promise<string> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new GmailAuthError('not_configured', null, 'Gmail is not configured');
  }
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    }).toString()
  });
  if (!response.ok) {
    // Google's token endpoint returns {"error": "invalid_grant", ...} on a
    // 400 — a short, defined OAuth error code (RFC 6749 §5.2), never a
    // secret. error_description is intentionally never read/logged (it can
    // occasionally be more verbose than we want to persist).
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    const category = categorizeGoogleError(response.status, body?.error ?? null);
    console.error('[GMAIL AUTH FAIL] token refresh failed, status=', response.status, 'code=', body?.error ?? 'unknown');
    throw new GmailAuthError(category, response.status, 'Failed to obtain Gmail access token');
  }
  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

// Verifies the Gmail OAuth credentials actually work by performing a real
// token refresh against Google — and nothing else. A refresh-token exchange
// never sends an email, so this is safe to call from a scheduled job's own
// dry-run/diagnostic path (see src/routes/cron.ts) or any other caller that
// needs to know "is Gmail actually authenticated right now" without risking
// a real send. Return shape intentionally unchanged from before (still just
// 'not_configured' | 'auth_failed') — callers relying on this exact dry-run
// contract are unaffected; use diagnoseGmailSend() below for the richer
// category.
export async function verifyGmailAuth(env: Env): Promise<{ ok: true } | { ok: false; errorCategory: 'not_configured' | 'auth_failed' }> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    return { ok: false, errorCategory: 'not_configured' };
  }
  try {
    await getAccessToken(env);
    return { ok: true };
  } catch {
    return { ok: false, errorCategory: 'auth_failed' };
  }
}

function toBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

interface PreparedGmailMessage {
  accessToken: string;
  rawMessageBase64Url: string;
}

// The exact preparation sendEmail() itself performs — extracted so a
// diagnostic caller (diagnoseGmailSend() below) exercises byte-for-byte the
// same access-token/message-build/encoding logic as a real send, with zero
// duplicated implementation to drift out of sync. Never calls SEND_URL.
async function prepareGmailSend(env: Env, to: string, subject: string, html: string): Promise<PreparedGmailMessage> {
  const accessToken = await getAccessToken(env);
  const message = [
    'From: Mi Casa Care Homes <micasacarehomes@gmail.com>',
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html
  ].join('\n');
  return { accessToken, rawMessageBase64Url: toBase64Url(message) };
}

// Returns the Gmail API's own message id on success — callers that need an
// audit trail (see routes/internal.ts's /gmail/test-send) can record it
// without ever touching the access token or the message body themselves.
export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<{ id: string | null }> {
  const { accessToken, rawMessageBase64Url } = await prepareGmailSend(env, to, subject, html);

  const response = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: rawMessageBase64Url })
  });

  if (!response.ok) {
    console.error('[GMAIL AUTH FAIL] send failed, status=', response.status);
    throw new Error('Failed to send email');
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  return { id: body?.id ?? null };
}

export type GmailSendDiagnosticCategory = 'not_configured' | 'invalid_grant' | 'rate_limited' | 'transient' | 'unknown_auth_error' | 'message_build_failed';

export interface GmailSendDiagnostic {
  ok: boolean;
  phase: 'gmail_auth' | 'message_build' | 'ready';
  category: GmailSendDiagnosticCategory | null;
  gmailAuthOk: boolean;
  messageBuilt: boolean;
}

// Exercises everything a real send does — auth, message construction,
// base64url encoding — using the exact same prepareGmailSend() a real send
// calls, and stops immediately before the network call to SEND_URL. No
// email is ever sent by this function, regardless of outcome. Used by
// src/routes/cron.ts's `?diagnostic=true` mode.
export async function diagnoseGmailSend(env: Env, to: string, subject: string, html: string): Promise<GmailSendDiagnostic> {
  try {
    await prepareGmailSend(env, to, subject, html);
    return { ok: true, phase: 'ready', category: null, gmailAuthOk: true, messageBuilt: true };
  } catch (e) {
    if (e instanceof GmailAuthError) {
      return { ok: false, phase: 'gmail_auth', category: e.category, gmailAuthOk: false, messageBuilt: false };
    }
    // Message construction/encoding is plain string/TextEncoder work and
    // realistically can't throw for well-formed inputs — this branch exists
    // so an unexpected failure here is still categorized, never uncaught.
    return { ok: false, phase: 'message_build', category: 'message_build_failed', gmailAuthOk: true, messageBuilt: false };
  }
}
