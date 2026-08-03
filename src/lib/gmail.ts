import type { Env } from '../env';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

async function getAccessToken(env: Env): Promise<string> {
  if (!env.GMAIL_CLIENT_ID || !env.GMAIL_CLIENT_SECRET || !env.GMAIL_REFRESH_TOKEN) {
    throw new Error('Gmail is not configured');
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
    console.error('[GMAIL AUTH FAIL] token refresh failed, status=', response.status);
    throw new Error('Failed to obtain Gmail access token');
  }
  const json = (await response.json()) as { access_token: string };
  return json.access_token;
}

// Verifies the Gmail OAuth credentials actually work by performing a real
// token refresh against Google — and nothing else. A refresh-token exchange
// never sends an email, so this is safe to call from a scheduled job's own
// dry-run/diagnostic path (see src/routes/cron.ts) or any other caller that
// needs to know "is Gmail actually authenticated right now" without risking
// a real send. Mirrors the same 'not_configured'/'auth_failed' category
// vocabulary routes/internal.ts's /gmail/test-send already established.
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

// Returns the Gmail API's own message id on success — callers that need an
// audit trail (see routes/internal.ts's /gmail/test-send) can record it
// without ever touching the access token or the message body themselves.
export async function sendEmail(env: Env, to: string, subject: string, html: string): Promise<{ id: string | null }> {
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

  const response = await fetch(SEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw: toBase64Url(message) })
  });

  if (!response.ok) {
    console.error('[GMAIL AUTH FAIL] send failed, status=', response.status);
    throw new Error('Failed to send email');
  }

  const body = (await response.json().catch(() => null)) as { id?: string } | null;
  return { id: body?.id ?? null };
}
