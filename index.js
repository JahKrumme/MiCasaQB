if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const OAuthClient = require('intuit-oauth');
const { google } = require('googleapis');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app = express();
app.set('trust proxy', 1);
app.use(express.json());

// --- Session & Google OAuth ---

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000,
    secure: process.env.NODE_ENV === 'production'
  }
}));

app.use(passport.initialize());
app.use(passport.session());

const googleCallbackURL = process.env.RENDER_EXTERNAL_URL
  ? `${process.env.RENDER_EXTERNAL_URL}/auth/google/callback`
  : 'http://localhost:3000/auth/google/callback';

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: googleCallbackURL
}, async (accessToken, refreshToken, profile, done) => {
  const email = profile.emails?.[0]?.value;
  if (!email) return done(null, false);
  try {
    const { data } = await supabase
      .from('allowed_emails')
      .select('email')
      .eq('email', email)
      .single();
    if (!data) return done(null, false);
    return done(null, { email, name: profile.displayName });
  } catch (e) {
    return done(e);
  }
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// QuickBooks OAuth
const oauthClient = new OAuthClient({
  clientId: process.env.INTUIT_CLIENT_ID,
  clientSecret: process.env.INTUIT_CLIENT_SECRET,
  environment: process.env.INTUIT_ENVIRONMENT,
  redirectUri: process.env.INTUIT_REDIRECT_URI
});

// Gmail OAuth
const gmailAuth = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  'http://localhost:3000/gmail/callback'
);

// QB token stored in memory — loaded from Supabase on startup
let qbRealmId = null;

(async () => {
  try {
    const tokens = await loadTokensFromSupabase();
    if (tokens) {
      qbRealmId = tokens.realm_id;
      oauthClient.setToken({ refresh_token: tokens.refresh_token });
      console.log('[STARTUP LOAD] Token from Supabase starting:', tokens.refresh_token?.substring(0, 15));
    }
  } catch (e) {
    console.error('Startup QB token load failed:', e.message);
  }
})();

async function getRecipients() {
  try {
    const { data, error } = await supabase.from('allowed_emails').select('email');
    if (error || !data || data.length === 0) throw new Error('empty');
    return data.map(row => row.email).join(', ');
  } catch (e) {
    console.error('Failed to load recipients from Supabase, using fallback:', e.message);
    return 'elijahkrumme@gmail.com';
  }
}

// --- helpers ---

async function getGmailClient() {
  gmailAuth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: gmailAuth });
}

// GMAIL_REFRESH_TOKEN must be obtained by authorizing with micasacarehomes@gmail.com at /gmail/connect
async function sendEmail(to, subject, html) {
  const gmail = await getGmailClient();
  const message = [
    'From: Mi Casa Care Homes <micasacarehomes@gmail.com>',
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    html
  ].join('\n');
  const encoded = Buffer.from(message).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

async function saveTokensToSupabase(accessToken, refreshToken, realmId) {
  console.log('[SUPABASE SAVE] Attempting to save token starting:', refreshToken?.substring(0, 15));
  try {
    const { data, error } = await supabase
      .from('qb_tokens')
      .upsert({ id: 1, access_token: accessToken, refresh_token: refreshToken, realm_id: realmId })
      .select();
    if (error) {
      console.error('[SUPABASE SAVE ERROR]', JSON.stringify(error));
    } else {
      console.log('[SUPABASE SAVE RESULT]', JSON.stringify(data));
    }
    return { data, error };
  } catch (e) {
    console.error('[SUPABASE SAVE EXCEPTION]', e.stack || e.message);
    throw e;
  }
}

async function loadTokensFromSupabase() {
  const { data, error } = await supabase
    .from('qb_tokens')
    .select('*')
    .eq('id', 1)
    .single();
  if (error) {
    console.error('Failed to load tokens from Supabase:', error.message);
    return null;
  }
  return data;
}

async function qbQuery(query) {
  await oauthClient.refresh();
  const base = process.env.INTUIT_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  const url = `${base}/v3/company/${qbRealmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
  const response = await oauthClient.makeApiCall({ url });
  return JSON.parse(response.body);
}

async function getActiveCustomers() {
  if (!qbRealmId) throw new Error('QB not connected');
  const data = await qbQuery('SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
  const customers = data.QueryResponse?.Customer || [];
  return customers.map(c => c.DisplayName || c.FullyQualifiedName).filter(Boolean);
}

async function getResidentRates() {
  if (!qbRealmId) throw new Error('QB not connected');
  const data = await qbQuery('SELECT * FROM Invoice ORDER BY TxnDate DESC MAXRESULTS 200');
  const invoices = data.QueryResponse?.Invoice || [];
  const rates = {};
  for (const inv of invoices) {
    const name = inv.CustomerRef?.name;
    if (name && !(name in rates)) {
      rates[name] = Number(inv.TotalAmt);
    }
  }
  return rates;
}

async function qbCreate(endpoint, body) {
  await oauthClient.refresh();
  const base = process.env.INTUIT_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  const url = `${base}/v3/company/${qbRealmId}/${endpoint}?minorversion=65`;
  const response = await oauthClient.makeApiCall({
    url,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify(body)
  });
  return JSON.parse(response.body);
}

function requireLogin(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.redirect('/login');
}

function requireLoginApi(req, res, next) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: 'Session expired. Please sign in again.' });
}

async function ensureQBToken() {
  const { data, error } = await supabase
    .from('qb_tokens')
    .select('*')
    .eq('id', 1)
    .single();

  if (error || !data) throw new Error('No token record found in Supabase');

  qbRealmId = data.realm_id;
  oauthClient.setToken({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    realmId: data.realm_id
  });

  console.log('[QB REFRESH] Attempting refresh with token starting:', data.refresh_token?.substring(0, 15));
  const authResponse = await oauthClient.refresh();
  const tokenJson = authResponse.getJson();
  console.log('[QB REFRESH SUCCESS] New token starting:', tokenJson.refresh_token?.substring(0, 15));

  await saveTokensToSupabase(tokenJson.access_token, tokenJson.refresh_token, data.realm_id);
}

async function ensureQBTokenMiddleware(req, res, next) {
  console.log('[QB MIDDLEWARE] Request to', req.path, 'at', new Date().toISOString());
  try {
    await ensureQBToken();
    next();
  } catch (e) {
    console.error('QB token refresh failed:', e.message);
    res.status(503).json({ error: 'QB token expired', reconnect: '/connect' });
  }
}

app.use('/qb', requireLoginApi, ensureQBTokenMiddleware);
app.use(['/run-check', '/run-30-day-alert', '/run-monthly-invoices', '/overdue-invoices', '/30-day-alert', '/monthly-invoices'], ensureQBTokenMiddleware);

// --- Auth routes ---

function loginPage(errorMsg) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign In — Mi Casa Care Homes</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #ede8e1;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 48px 40px;
      max-width: 400px;
      width: 100%;
      text-align: center;
      box-shadow: 0 4px 24px rgba(92,61,30,0.12);
    }
    .logo {
      width: 64px;
      height: 64px;
      background: #5C3D1E;
      border-radius: 16px;
      margin: 0 auto 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }
    h1 { font-size: 22px; font-weight: 700; color: #3B2107; margin-bottom: 8px; }
    .subtitle { font-size: 14px; color: #888; margin-bottom: 32px; }
    .error {
      background: #fff0f0;
      border: 1px solid #f5c2c7;
      color: #9b0000;
      border-radius: 8px;
      padding: 12px 16px;
      font-size: 13px;
      margin-bottom: 24px;
      text-align: left;
    }
    .google-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: #5C3D1E;
      color: #C49A2A;
      text-decoration: none;
      border-radius: 10px;
      padding: 14px 24px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.01em;
      transition: background 0.15s;
    }
    .google-btn:hover { background: #7a5230; }
    footer { margin-top: 32px; font-size: 12px; color: #bbb; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🏠</div>
    <h1>Casa QuickBooks Companion</h1>
    <p class="subtitle">Mi Casa Care Homes LLC &mdash; Staff Access Only</p>
    ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
    <a href="/auth/google" class="google-btn">
      <svg width="20" height="20" viewBox="0 0 48 48">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
      Sign in with Google
    </a>
    <footer>&copy; ${new Date().getFullYear()} Mi Casa Care Homes LLC</footer>
  </div>
</body>
</html>`;
}

app.get('/login', (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/assistant');
  const error = req.query.error === 'unauthorized'
    ? 'Your Google account is not authorized. Contact your administrator.'
    : null;
  res.send(loginPage(error));
});

app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login?error=unauthorized' }),
  (req, res) => res.redirect('/assistant')
);

app.get('/auth/logout', (req, res) => {
  req.logout(err => {
    if (err) console.error('Logout error:', err);
    res.redirect('/login');
  });
});

// --- Admin routes ---

async function requireAdmin(req, res, next) {
  const email = req.user?.email;
  if (!email) return res.redirect('/assistant');
  try {
    const { data } = await supabase
      .from('allowed_emails')
      .select('email')
      .eq('email', email)
      .single();
    if (!data) return res.redirect('/assistant');
    next();
  } catch (e) {
    res.redirect('/assistant');
  }
}

async function requireAdminApi(req, res, next) {
  const email = req.user?.email;
  if (!email) return res.status(403).json({ error: 'Access denied' });
  try {
    const { data } = await supabase
      .from('allowed_emails')
      .select('email')
      .eq('email', email)
      .single();
    if (!data) return res.status(403).json({ error: 'Access denied' });
    next();
  } catch (e) {
    res.status(403).json({ error: 'Access denied' });
  }
}

const adminPage = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin — Mi Casa Care Homes</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #ede8e1;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      padding: 32px 16px;
    }
    .page {
      width: 100%;
      max-width: 560px;
    }
    header {
      background: #5C3D1E;
      border-radius: 14px 14px 0 0;
      padding: 20px 24px;
      display: flex;
      align-items: center;
      gap: 16px;
    }
    header h1 {
      font-size: 18px;
      font-weight: 700;
      color: #C49A2A;
      flex: 1;
    }
    header a {
      color: rgba(255,255,255,0.6);
      text-decoration: none;
      font-size: 13px;
    }
    header a:hover { color: #C49A2A; }
    .card {
      background: #fff;
      border-radius: 0 0 14px 14px;
      box-shadow: 0 4px 24px rgba(92,61,30,0.12);
      overflow: hidden;
    }
    .section {
      padding: 24px;
      border-bottom: 1px solid #f0ebe3;
    }
    .section:last-child { border-bottom: none; }
    .section-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #888;
      margin-bottom: 16px;
    }
    table { width: 100%; border-collapse: collapse; }
    td {
      padding: 10px 0;
      font-size: 14px;
      color: #2a1a08;
      border-bottom: 1px solid #f5f1ec;
    }
    tr:last-child td { border-bottom: none; }
    td.email-cell { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 13px; }
    td.action-cell { text-align: right; width: 80px; }
    .btn-remove {
      background: none;
      border: 1px solid #e0b0b0;
      color: #9b0000;
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      font-weight: 600;
      transition: background 0.15s;
    }
    .btn-remove:hover { background: #fff0f0; }
    .empty { color: #aaa; font-size: 14px; font-style: italic; }
    .add-row {
      display: flex;
      gap: 10px;
    }
    .add-row input {
      flex: 1;
      border: 1.5px solid #d6c9bc;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      font-family: inherit;
      color: #2a1a08;
      background: #faf7f4;
      outline: none;
      transition: border-color 0.15s;
    }
    .add-row input:focus { border-color: #C49A2A; background: #fff; }
    .btn-add {
      background: #5C3D1E;
      color: #C49A2A;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.15s;
    }
    .btn-add:hover { background: #7a5230; }
    .btn-add:disabled { opacity: 0.4; cursor: default; }
    #toast {
      margin-top: 16px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      display: none;
    }
    #toast.success { background: #f0fff4; border: 1px solid #a3d9a5; color: #2d6a2d; display: block; }
    #toast.error { background: #fff0f0; border: 1px solid #f5c2c7; color: #9b0000; display: block; }
  </style>
</head>
<body>
<div class="page">
  <header>
    <h1>Access Management</h1>
    <a href="/assistant">&larr; Back to Companion</a>
  </header>
  <div class="card">
    <div class="section">
      <div class="section-title">Allowed Emails</div>
      <table id="email-table"><tbody id="email-list"><tr><td class="empty">Loading&hellip;</td></tr></tbody></table>
    </div>
    <div class="section">
      <div class="section-title">Add Email</div>
      <div class="add-row">
        <input type="email" id="new-email" placeholder="name@example.com">
        <button class="btn-add" id="add-btn">Add</button>
      </div>
      <div id="toast"></div>
    </div>
  </div>
</div>
<script>
async function loadEmails() {
  const tbody = document.getElementById('email-list');
  try {
    const res = await fetch('/admin/emails');
    const data = await res.json();
    if (!data.emails || data.emails.length === 0) {
      tbody.innerHTML = '<tr><td class="empty">No emails in the allowed list.</td></tr>';
      return;
    }
    tbody.innerHTML = data.emails.map(e => \`
      <tr>
        <td class="email-cell">\${e.email}</td>
        <td class="action-cell">
          <button class="btn-remove" onclick="removeEmail('\${e.email}')">Remove</button>
        </td>
      </tr>\`).join('');
  } catch (err) {
    tbody.innerHTML = '<tr><td class="empty" style="color:#9b0000">Failed to load emails.</td></tr>';
  }
}

function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = type;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = ''; el.style.display = 'none'; }, 4000);
}

async function removeEmail(email) {
  try {
    const res = await fetch('/admin/remove-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to remove email.', 'error'); return; }
    showToast(email + ' removed.', 'success');
    loadEmails();
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
}

document.getElementById('add-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-email');
  const email = input.value.trim().toLowerCase();
  if (!email) return;
  const btn = document.getElementById('add-btn');
  btn.disabled = true;
  try {
    const res = await fetch('/admin/add-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Failed to add email.', 'error'); }
    else { showToast(email + ' added.', 'success'); input.value = ''; loadEmails(); }
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  }
  btn.disabled = false;
});

document.getElementById('new-email').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('add-btn').click();
});

loadEmails();
</script>
</body>
</html>`;

app.get('/admin', requireLogin, requireAdmin, (req, res) => {
  res.send(adminPage);
});

app.get('/admin/emails', requireLogin, requireAdminApi, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('allowed_emails')
      .select('email')
      .order('email', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ emails: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/add-email', requireLogin, requireAdminApi, async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  try {
    const { error } = await supabase
      .from('allowed_emails')
      .insert({ email: email.toLowerCase().trim() });
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Email is already in the list.' });
      return res.status(500).json({ error: error.message });
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/admin/remove-email', requireLogin, requireAdminApi, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  try {
    const { error } = await supabase
      .from('allowed_emails')
      .delete()
      .eq('email', email.toLowerCase().trim());
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// QuickBooks connect route
app.get('/connect', (req, res) => {
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: 'mi-casa-qb'
  });
  res.redirect(authUri);
});

// QuickBooks callback
app.get('/callback', async (req, res) => {
  try {
    await oauthClient.createToken(req.url);
    qbRealmId = req.query.realmId;
    const token = oauthClient.getToken();
    console.log('Callback fired, realmId: ' + req.query.realmId);
    console.log('Token set on oauthClient: ' + JSON.stringify(token));
    saveTokensToSupabase(token.access_token, token.refresh_token, qbRealmId).catch(e => console.error('Supabase save error:', e));
    res.send('QuickBooks connected! Token stored in memory. <a href="/overdue-invoices">View overdue invoices</a>');
  } catch (e) {
    console.error('QB callback error:', e);
    res.send('Something went wrong: ' + e.message);
  }
});

// Gmail connect route
app.get('/gmail/connect', (req, res) => {
  const authUrl = gmailAuth.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/gmail.send']
  });
  res.redirect(authUrl);
});

// Gmail callback
app.get('/gmail/callback', async (req, res) => {
  try {
    const { tokens } = await gmailAuth.getToken(req.query.code);
    gmailAuth.setCredentials(tokens);
    console.log('GMAIL_REFRESH_TOKEN=' + tokens.refresh_token);
    res.send('Gmail connected! Copy the refresh token from your terminal into your .env file.');
  } catch (e) {
    console.error('Gmail error:', e);
    res.send('Something went wrong: ' + e.message);
  }
});

// Send a test email
app.get('/send-test', async (req, res) => {
  try {
    const html = `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
        <h2 style="color:#1a1a1a">QuikBooks App — Test Email</h2>
        <p style="color:#444">It works! Your Gmail API connection is live and ready.</p>
        <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
        <p style="color:#999;font-size:12px">Sent from your QuikBooks integration</p>
      </div>`;
    await sendEmail(await getRecipients(), 'Test Email from QuikBooks App', html);
    res.send('Test email sent to elijahkrumme@gmail.com');
  } catch (e) {
    console.error('Send-test error:', e);
    res.status(500).send('Failed to send email: ' + e.message);
  }
});

async function runOverdueCheck() {
  if (!qbRealmId) {
    console.log('QB token expired — re-authorization needed');
    return { status: 'no-token' };
  }
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];
  let data;
  try {
    data = await qbQuery(`SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${firstOfMonth}'`);
  } catch (e) {
    console.log('QB token expired — re-authorization needed');
    return { status: 'token-error', message: e.message };
  }

  const invoices = data.QueryResponse?.Invoice || [];
  if (invoices.length === 0) {
    console.log('Daily overdue check complete — no overdue invoices found.');
    return { status: 'ok', count: 0 };
  }

  const rows = invoices.map(inv => {
    const due = new Date(inv.DueDate);
    const daysOverdue = Math.floor((today - due) / (1000 * 60 * 60 * 24));
    const urgency = daysOverdue > 60 ? '#c0392b' : daysOverdue > 30 ? '#e67e22' : '#2c3e50';
    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">#${inv.DocNumber}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.CustomerRef?.name || 'N/A'}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.DueDate}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;color:${urgency};font-weight:600">${daysOverdue} days</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">$${Number(inv.Balance).toFixed(2)}</td>
      </tr>`;
  }).join('');

  const totalBalance = invoices.reduce((sum, inv) => sum + Number(inv.Balance), 0);

  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Overdue Invoices</h2>
      <p style="color:#555">As of <strong>${todayStr}</strong> — ${invoices.length} invoice(s) overdue</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Invoice</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Customer</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Due Date</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Days Overdue</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Balance</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="background:#fafafa">
            <td colspan="4" style="padding:12px 16px;font-weight:700;text-align:right">Total Outstanding:</td>
            <td style="padding:12px 16px;font-weight:700;color:#c0392b">$${totalBalance.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuikBooks integration</p>
    </div>`;

  await sendEmail(await getRecipients(), `Overdue Invoices — ${invoices.length} unpaid ($${totalBalance.toFixed(2)})`, html);
  console.log('Daily overdue check complete');
  return { status: 'ok', count: invoices.length, total: totalBalance };
}

// Fetch overdue invoices from QB and email them
app.get('/overdue-invoices', async (req, res) => {
  console.log('qbRealmId value: ' + qbRealmId);
  console.log('Token valid: ' + oauthClient.isAccessTokenValid());
  if (!qbRealmId) {
    return res.redirect('/connect');
  }
  try {
    const result = await runOverdueCheck();
    if (result.status === 'no-token' || result.status === 'token-error') {
      return res.redirect('/connect');
    }
    if (result.count === 0) {
      return res.send('No overdue invoices found.');
    }
    res.send(`Found ${result.count} overdue invoice(s). Email sent to elijahkrumme@gmail.com.`);
  } catch (e) {
    console.error('Overdue-invoices error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});

// Manually trigger the daily check
app.get('/run-check', async (req, res) => {
  try {
    const result = await runOverdueCheck();
    if (result.status === 'no-token' || result.status === 'token-error') {
      return res.status(503).send('QB token expired — visit <a href="/connect">/connect</a> to re-authorize.');
    }
    if (result.count === 0) {
      return res.send('Check complete — no invoices past due before the 1st of this month.');
    }
    res.send(`Check complete — ${result.count} overdue invoice(s), $${result.total.toFixed(2)} total. Email sent.`);
  } catch (e) {
    console.error('Run-check error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});

async function run30DayAlert() {
  if (!qbRealmId) {
    console.log('QB token expired — re-authorization needed');
    return { status: 'no-token' };
  }
  const today = new Date();
  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = cutoff.toISOString().split('T')[0];
  const todayStr = today.toISOString().split('T')[0];

  let data;
  try {
    data = await qbQuery(`SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${cutoffStr}'`);
  } catch (e) {
    console.log('QB token expired — re-authorization needed');
    return { status: 'token-error', message: e.message };
  }

  const invoices = data.QueryResponse?.Invoice || [];
  if (invoices.length === 0) {
    console.log('No 30-day overdue invoices today');
    return { status: 'ok', count: 0 };
  }

  const rows = invoices.map(inv => {
    const due = new Date(inv.DueDate);
    const daysOverdue = Math.floor((today - due) / (1000 * 60 * 60 * 24));
    return `
      <tr>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">#${inv.DocNumber}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.CustomerRef?.name || 'N/A'}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.DueDate}</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;color:#c0392b;font-weight:600">${daysOverdue} days</td>
        <td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">$${Number(inv.Balance).toFixed(2)}</td>
      </tr>`;
  }).join('');

  const totalBalance = invoices.reduce((sum, inv) => sum + Number(inv.Balance), 0);

  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
      <h2 style="color:#c0392b">Action Required: Invoices 30+ Days Overdue</h2>
      <p style="color:#555">As of <strong>${todayStr}</strong> — ${invoices.length} invoice(s) are more than 30 days past due.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Invoice</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Customer</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Due Date</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Days Overdue</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Balance</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="background:#fafafa">
            <td colspan="4" style="padding:12px 16px;font-weight:700;text-align:right">Total Outstanding:</td>
            <td style="padding:12px 16px;font-weight:700;color:#c0392b">$${totalBalance.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuikBooks integration</p>
    </div>`;

  await sendEmail(await getRecipients(), 'Action Required: Invoices 30+ Days Overdue', html);
  return { status: 'ok', count: invoices.length, total: totalBalance };
}

app.get('/30-day-alert', async (req, res) => {
  if (!qbRealmId) return res.redirect('/connect');
  try {
    const result = await run30DayAlert();
    if (result.status === 'no-token' || result.status === 'token-error') {
      return res.redirect('/connect');
    }
    if (result.count === 0) return res.send('No invoices 30+ days overdue.');
    res.send(`Found ${result.count} invoice(s) 30+ days overdue. Email sent to elijahkrumme@gmail.com.`);
  } catch (e) {
    console.error('30-day-alert error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});

app.get('/run-30-day-alert', async (req, res) => {
  try {
    const result = await run30DayAlert();
    if (result.status === 'no-token' || result.status === 'token-error') {
      return res.status(503).send('QB token expired — visit <a href="/connect">/connect</a> to re-authorize.');
    }
    if (result.count === 0) return res.send('Check complete — no invoices 30+ days overdue.');
    res.send(`Check complete — ${result.count} invoice(s) 30+ days overdue, $${result.total.toFixed(2)} total. Email sent.`);
  } catch (e) {
    console.error('Run-30-day-alert error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});

async function runMonthlyInvoices() {
  if (!qbRealmId) {
    console.log('QB token expired — re-authorization needed');
    return { status: 'no-token' };
  }

  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const nextMonthLabel = nextMonth.toLocaleString('default', { month: 'long', year: 'numeric' });
  const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  let data;
  try {
    data = await qbQuery(`SELECT * FROM Invoice WHERE TxnDate >= '${firstDay}' AND TxnDate <= '${lastDay}'`);
  } catch (e) {
    console.log('QB token expired — re-authorization needed');
    return { status: 'token-error', message: e.message };
  }

  const invoices = data.QueryResponse?.Invoice || [];
  if (invoices.length === 0) {
    console.log(`Monthly invoice summary: no invoices found for ${monthLabel}`);
    return { status: 'ok', count: 0 };
  }

  const rows = invoices.map(inv => `
    <tr>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">#${inv.DocNumber}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.CustomerRef?.name || 'N/A'}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.TxnDate}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee">${inv.DueDate || '—'}</td>
      <td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">$${Number(inv.TotalAmt).toFixed(2)}</td>
    </tr>`).join('');

  const totalAmt = invoices.reduce((sum, inv) => sum + Number(inv.TotalAmt), 0);

  const html = `
    <div style="font-family:sans-serif;max-width:700px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">Mi Casa — Your Invoice for ${nextMonthLabel} is Ready</h2>
      <p style="color:#555">Your invoice for <strong>${nextMonthLabel}</strong> has been prepared. Please review the details below.</p>
      <p style="color:#444">Payment is due on the <strong>1st of ${nextMonthLabel}</strong>. We accept payments through the <strong>5th</strong>.</p>
      <table style="width:100%;border-collapse:collapse;margin-top:16px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Invoice</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Customer</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Created</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Due Date</th>
            <th style="padding:12px 16px;text-align:left;font-size:13px;color:#666">Amount</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
        <tfoot>
          <tr style="background:#fafafa">
            <td colspan="4" style="padding:12px 16px;font-weight:700;text-align:right">Total Invoiced:</td>
            <td style="padding:12px 16px;font-weight:700;color:#1a1a1a">$${totalAmt.toFixed(2)}</td>
          </tr>
        </tfoot>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuikBooks integration</p>
    </div>`;

  await sendEmail(await getRecipients(), `Mi Casa — Your Invoice for ${nextMonthLabel} is Ready`, html);
  console.log(`Monthly invoice notice sent for ${nextMonthLabel}`);
  return { status: 'ok', count: invoices.length, total: totalAmt };
}

app.get('/monthly-invoices', async (req, res) => {
  if (!qbRealmId) return res.redirect('/connect');
  try {
    const result = await runMonthlyInvoices();
    if (result.status === 'no-token' || result.status === 'token-error') return res.redirect('/connect');
    if (result.count === 0) return res.send('No invoices found for this month.');
    res.send(`Found ${result.count} invoice(s) this month. Email sent to elijahkrumme@gmail.com.`);
  } catch (e) {
    console.error('Monthly-invoices error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});

app.get('/run-monthly-invoices', async (req, res) => {
  try {
    const result = await runMonthlyInvoices();
    if (result.status === 'no-token' || result.status === 'token-error') {
      return res.status(503).send('QB token expired — visit <a href="/connect">/connect</a> to re-authorize.');
    }
    if (result.count === 0) return res.send('Check complete — no invoices found for this month. No email sent.');
    res.send(`Check complete — next month invoice notice sent with ${result.count} invoice(s), $${result.total.toFixed(2)} total.`);
  } catch (e) {
    console.error('Run-monthly-invoices error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});


async function runKanCareReminder() {
  const now = new Date();
  const monthLabel = now.toLocaleString('default', { month: 'long', year: 'numeric' });

  const html = `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <h2 style="color:#1a1a1a">KanCare Billing Deadline Reminder</h2>
      <p style="color:#444">This is a reminder that <strong>KanCare claims for ${monthLabel} are due soon.</strong></p>
      <p style="color:#444">Please ensure all claims for the current month are submitted before the end of the month to avoid delays in reimbursement.</p>
      <ul style="color:#444;line-height:1.8">
        <li>Review all services rendered in ${monthLabel}</li>
        <li>Verify documentation is complete for each claim</li>
        <li>Submit all claims before the end of the month</li>
      </ul>
      <p style="color:#c0392b;font-weight:600">Deadline: End of ${monthLabel}</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Sent from your QuikBooks integration</p>
    </div>`;

  await sendEmail(await getRecipients(), 'KanCare Billing Deadline Reminder', html);
  console.log(`KanCare reminder sent for ${monthLabel}`);
}

app.get('/run-kancare-reminder', async (req, res) => {
  try {
    await runKanCareReminder();
    res.send('KanCare billing reminder sent to elijahkrumme@gmail.com.');
  } catch (e) {
    console.error('KanCare reminder error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});

app.get('/keep-alive', async (req, res) => {
  try {
    console.log('Keep-alive: Refreshing QB token...');
    await ensureQBToken();
    console.log('Keep-alive: Token refreshed successfully');
    res.status(200).json({ status: 'ok', message: 'QB token refreshed successfully' });
  } catch (e) {
    console.error('Keep-alive: Token refresh failed:', e.message);
    res.status(503).json({ status: 'error', message: 'Token refresh failed', error: e.message });
  }
});

app.get('/disconnect', (req, res) => {
  qbRealmId = null;
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Disconnected — Mi Casa Care Homes LLC</title>
<style>body{font-family:sans-serif;max-width:680px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}hr{border:none;border-top:1px solid #ddd;margin:24px 0}p{color:#444}</style>
</head>
<body>
  <h1>Disconnected from QuickBooks</h1>
  <hr>
  <p>You have been disconnected from QuickBooks. Contact your administrator to reconnect.</p>
  <hr>
  <p style="font-size:13px;color:#999">&copy; ${new Date().getFullYear()} Mi Casa Care Homes LLC. All rights reserved.</p>
</body>
</html>`);
});

app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Terms of Use — Mi Casa Care Homes LLC</title>
<style>body{font-family:sans-serif;max-width:680px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}hr{border:none;border-top:1px solid #ddd;margin:24px 0}p{color:#444}</style>
</head>
<body>
  <h1>Terms of Use</h1>
  <hr>
  <p>This application is an internal tool operated by <strong>Mi Casa Care Homes LLC</strong> and is intended solely for use by authorized staff members.</p>
  <p>This tool is not intended for public use. Unauthorized access or use of this application is strictly prohibited.</p>
  <p>By accessing this application, you confirm that you are an authorized employee or representative of Mi Casa Care Homes LLC.</p>
  <hr>
  <p style="font-size:13px;color:#999">&copy; ${new Date().getFullYear()} Mi Casa Care Homes LLC. All rights reserved.</p>
</body>
</html>`);
});

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Privacy Policy — Mi Casa Care Homes LLC</title>
<style>body{font-family:sans-serif;max-width:680px;margin:60px auto;padding:0 24px;color:#222;line-height:1.7}h1{font-size:24px;margin-bottom:8px}hr{border:none;border-top:1px solid #ddd;margin:24px 0}p{color:#444}</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <hr>
  <p>This application is operated by <strong>Mi Casa Care Homes LLC</strong> for internal billing and administrative purposes only.</p>
  <p>This app accesses QuickBooks financial data solely to support internal billing operations at Mi Casa Care Homes LLC. No financial data or personal information is shared with third parties.</p>
  <p>Access to this application is restricted to authorized staff only. All data accessed through this tool remains confidential and is used exclusively for internal operations.</p>
  <hr>
  <p style="font-size:13px;color:#999">&copy; ${new Date().getFullYear()} Mi Casa Care Homes LLC. All rights reserved.</p>
</body>
</html>`);
});


app.get('/assistant', requireLogin, (req, res) => {
  res.sendFile(__dirname + '/assistant.html');
});

app.post('/api/chat', requireLoginApi, async (req, res) => {
  try {
    const { messages, system } = req.body;

    const userContent = messages[messages.length - 1]?.content || '';
    const userMsgLower = userContent.toLowerCase();

    // Fetch QB customer data (needed for intent detection and system prompt)
    let customerNames = [];
    let customerRates = {};
    let customerSection;
    try {
      const [names, rates] = await Promise.all([getActiveCustomers(), getResidentRates()]);
      customerNames = names;
      customerRates = rates;
      const lines = names.map(name => {
        const rate = rates[name];
        return rate
          ? `- ${name}: $${Number(rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}`
          : `- ${name}: rate unknown`;
      });
      customerSection = `## Active Residents and Current Monthly Rates (pulled live from QuickBooks)\n${lines.join('\n')}`;
    } catch (e) {
      customerSection = '## Active Residents\nCustomer list unavailable — QB token may need refresh.';
    }

    // Intent detection — runs before Groq so we can short-circuit
    const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];
    const INVOICE_KEYWORDS = ['create invoice', 'make invoice', 'invoices for', 'monthly invoices', 'bill residents'];
    const PAYMENT_KEYWORDS = ['record payment', 'record a payment', 'received payment', 'payment from', 'payment for', 'log payment'];
    const RESIDENT_KEYWORDS = ['add resident', 'new resident', 'add client', 'move in'];
    const OVERDUE_KEYWORDS = ['overdue', 'unpaid', 'who owes', 'outstanding'];

    const hasInvoiceWord = userMsgLower.includes('invoice') || userMsgLower.includes('invoices');
    const hasMonth = MONTHS.some(m => userMsgLower.includes(m));
    const hasPaid = userMsgLower.includes('paid') && !userMsgLower.includes('unpaid');

    let intent = null;
    let paymentData = null;

    if (INVOICE_KEYWORDS.some(kw => userMsgLower.includes(kw)) || (hasInvoiceWord && hasMonth)) {
      intent = 'create-invoices';
    } else if (PAYMENT_KEYWORDS.some(kw => userMsgLower.includes(kw)) || hasPaid) {
      intent = 'record-payment';
      const amountMatch = userContent.match(/\$?([\d,]+(?:\.\d{2})?)/);
      const extractedAmount = amountMatch ? parseFloat(amountMatch[1].replace(/,/g, '')) : null;
      const extractedName = customerNames.find(name =>
        userMsgLower.includes(name.toLowerCase())
      ) || null;
      const rateAmount = extractedName ? (customerRates[extractedName] || null) : null;
      paymentData = { customerName: extractedName, amount: extractedAmount || rateAmount };
    } else if (RESIDENT_KEYWORDS.some(kw => userMsgLower.includes(kw))) {
      intent = 'add-resident';
    } else if (OVERDUE_KEYWORDS.some(kw => userMsgLower.includes(kw))) {
      intent = 'overdue-summary';
    }

    // When automation is available, skip the AI call — the card replaces the response
    if (intent) {
      return res.json({ text: null, intent, paymentData });
    }

    // No automation match — call Groq for a conversational response
    const augmentedSystem = system + '\n\n' + customerSection;
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: augmentedSystem },
        ...messages
      ],
      max_tokens: 1024
    });

    const text = completion.choices[0].message.content;
    res.json({ text, intent: null, paymentData: null });
  } catch (e) {
    console.error('Chat proxy error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/qb/preview-invoices', async (req, res) => {
  if (!qbRealmId) return res.status(503).json({ error: 'QuickBooks not connected — visit /connect to authorize.' });
  try {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const lastDay = new Date(today.getFullYear(), today.getMonth() + 1, 0).toISOString().split('T')[0];
    const invoiceDate = new Date(today.getFullYear(), today.getMonth(), 20).toISOString().split('T')[0];
    const dueDate = new Date(today.getFullYear(), today.getMonth() + 1, 1).toISOString().split('T')[0];

    const [custData, existingData, rates] = await Promise.all([
      qbQuery('SELECT * FROM Customer WHERE Active = true MAXRESULTS 100'),
      qbQuery(`SELECT * FROM Invoice WHERE TxnDate >= '${firstDay}' AND TxnDate <= '${lastDay}' MAXRESULTS 100`),
      getResidentRates()
    ]);

    const customers = custData.QueryResponse?.Customer || [];
    const existingInvoices = existingData.QueryResponse?.Invoice || [];
    const invoicedCustomerIds = new Set(existingInvoices.map(inv => inv.CustomerRef?.value));

    const preview = customers
      .filter(c => {
        const name = c.DisplayName || c.FullyQualifiedName;
        return name && rates[name] !== undefined;
      })
      .map(c => {
        const name = c.DisplayName || c.FullyQualifiedName;
        return {
          name,
          customerId: c.Id,
          amount: rates[name],
          invoiceDate,
          dueDate,
          alreadyInvoiced: invoicedCustomerIds.has(c.Id)
        };
      });

    const total = preview.reduce((sum, r) => sum + r.amount, 0);
    res.json({ preview, invoiceDate, dueDate, total });
  } catch (e) {
    console.error('Preview invoices error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/qb/create-invoices', async (req, res) => {
  if (!qbRealmId) return res.status(503).json({ error: 'QuickBooks not connected.' });
  try {
    const { preview } = req.body;

    // Find a service item matching room/board/care
    const itemData = await qbQuery("SELECT * FROM Item WHERE Type = 'Service' MAXRESULTS 50");
    const items = itemData.QueryResponse?.Item || [];
    const roomItem = items.find(i => /room|board|care|resident/i.test(i.Name)) || items[0];

    const results = [];
    for (const r of preview) {
      if (!r.customerId) {
        results.push({ name: r.name, status: 'skipped', reason: 'Customer not found in QuickBooks' });
        continue;
      }
      if (r.alreadyInvoiced) {
        results.push({ name: r.name, status: 'skipped', reason: 'Already invoiced this month' });
        continue;
      }
      try {
        const result = await qbCreate('invoice', {
          Line: [{
            Amount: r.amount,
            DetailType: 'SalesItemLineDetail',
            SalesItemLineDetail: {
              ItemRef: roomItem
                ? { value: roomItem.Id, name: roomItem.Name }
                : { value: '1', name: 'Services' },
              Qty: 1,
              UnitPrice: r.amount
            }
          }],
          CustomerRef: { value: r.customerId },
          TxnDate: r.invoiceDate,
          DueDate: r.dueDate
        });
        results.push({ name: r.name, status: 'created', invoiceId: result.Invoice?.Id, amount: r.amount });
      } catch (e) {
        results.push({ name: r.name, status: 'error', reason: e.message });
      }
    }

    const created = results.filter(r => r.status === 'created');
    const total = created.reduce((sum, r) => sum + r.amount, 0);
    res.json({ results, created: created.length, total });
  } catch (e) {
    console.error('Create invoices error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/qb/preview-payment', async (req, res) => {
  try {
    const { customerName, amount } = req.body;

    const custData = await qbQuery('SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
    const customers = custData.QueryResponse?.Customer || [];
    const customer = customers.find(c => {
      const name = (c.DisplayName || c.FullyQualifiedName || '').toLowerCase();
      return name.includes(customerName.toLowerCase()) || customerName.toLowerCase().includes(name);
    });

    if (!customer) {
      return res.json({ found: false, message: `No customer found matching "${customerName}"` });
    }

    const invData = await qbQuery(
      `SELECT * FROM Invoice WHERE CustomerRef = '${customer.Id}' AND Balance > '0' ORDER BY TxnDate DESC MAXRESULTS 1`
    );
    const invoices = invData.QueryResponse?.Invoice || [];

    if (invoices.length === 0) {
      return res.json({ found: false, message: `No open invoice found for ${customer.DisplayName}` });
    }

    const invoice = invoices[0];
    const today = new Date().toISOString().split('T')[0];

    res.json({
      found: true,
      customerId: customer.Id,
      customerName: customer.DisplayName,
      invoiceId: invoice.Id,
      invoiceNumber: invoice.DocNumber,
      invoiceAmount: Number(invoice.TotalAmt),
      invoiceBalance: Number(invoice.Balance),
      paymentAmount: amount || Number(invoice.Balance),
      paymentDate: today
    });
  } catch (e) {
    console.error('Preview payment error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/qb/record-payment', async (req, res) => {
  try {
    const { customerId, invoiceId, paymentAmount, paymentDate } = req.body;

    const result = await qbCreate('payment', {
      CustomerRef: { value: customerId },
      TotalAmt: paymentAmount,
      TxnDate: paymentDate,
      Line: [{
        Amount: paymentAmount,
        LinkedTxn: [{ TxnId: invoiceId, TxnType: 'Invoice' }]
      }]
    });

    res.json({ success: true, paymentId: result.Payment?.Id, amount: paymentAmount });
  } catch (e) {
    console.error('Record payment error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/qb/overdue-summary', async (req, res) => {
  try {
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const data = await qbQuery(
      `SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${todayStr}' ORDER BY DueDate ASC MAXRESULTS 100`
    );
    const invoices = data.QueryResponse?.Invoice || [];

    const items = invoices.map(inv => ({
      customerName: inv.CustomerRef?.name || 'Unknown',
      invoiceNumber: inv.DocNumber,
      dueDate: inv.DueDate,
      daysOverdue: Math.floor((today - new Date(inv.DueDate)) / (1000 * 60 * 60 * 24)),
      balance: Number(inv.Balance)
    }));

    const total = items.reduce((sum, i) => sum + i.balance, 0);
    res.json({ items, total, count: items.length });
  } catch (e) {
    console.error('Overdue summary error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/qb/preview-resident', async (req, res) => {
  try {
    const { name, paymentType, monthlyRate, moveInDate } = req.body;

    const custData = await qbQuery('SELECT * FROM Customer WHERE Active = true MAXRESULTS 100');
    const customers = custData.QueryResponse?.Customer || [];
    const duplicate = customers.find(c =>
      c.DisplayName?.toLowerCase() === name.toLowerCase()
    );

    res.json({
      name,
      paymentType,
      monthlyRate: Number(monthlyRate),
      moveInDate,
      isDuplicate: !!duplicate
    });
  } catch (e) {
    console.error('Preview resident error:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/qb/create-resident', async (req, res) => {
  try {
    const { name, paymentType, monthlyRate, moveInDate } = req.body;

    const notes = `Payment type: ${paymentType} | Monthly rate: $${Number(monthlyRate).toLocaleString('en-US', { minimumFractionDigits: 2 })} | Move-in date: ${moveInDate}`;

    const result = await qbCreate('customer', {
      DisplayName: name,
      PrintOnCheckName: name,
      Notes: notes
    });

    res.json({
      success: true,
      customerId: result.Customer?.Id,
      name,
      monthlyRate: Number(monthlyRate),
      paymentType,
      moveInDate
    });
  } catch (e) {
    console.error('Create resident error:', e);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Server running at ${base}`);
  console.log(`QuickBooks connect: ${base}/connect`);
  console.log('Scheduled jobs handled by GitHub Actions');
});