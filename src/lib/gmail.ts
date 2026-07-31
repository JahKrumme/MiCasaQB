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
