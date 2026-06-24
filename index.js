if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const OAuthClient = require('intuit-oauth');
const { google } = require('googleapis');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app = express();
app.use(express.json());

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
      await oauthClient.refresh();
      console.log('QB token refreshed from env vars');
    }
  } catch (e) {
    console.error('Startup QB token load failed:', e.message);
  }
})();

const RECIPIENTS = 'elijahkrumme@gmail.com, micasacarehomes@gmail.com, micasatyler@gmail.com, bom@wvmsks.com, office@wvmsks.com';

const RESIDENT_RATES = {
  'Beverly Herrell':  5885,
  'Carmen Gonzalez':  2710,
  'Joseph Trabert':   6955,
  'Marcia Kerschner': 1084,
  'Martha Warren':    2000,
  'Randal Jewet':     11609.50,
  'Todd Scott':       921
};

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
  const { error } = await supabase
    .from('qb_tokens')
    .upsert({ id: 1, access_token: accessToken, refresh_token: refreshToken, realm_id: realmId });
  if (error) {
    console.error('Failed to save tokens to Supabase:', error.message);
  } else {
    console.log('QB tokens saved to Supabase');
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

async function ensureQBToken(req, res, next) {
  if (!qbRealmId) {
    return res.status(503).json({ error: 'QB token expired', reconnect: '/connect' });
  }
  if (!oauthClient.isAccessTokenValid()) {
    try {
      await oauthClient.refresh();
      const token = oauthClient.getToken();
      console.log('QB token refreshed from env vars');
      saveTokensToSupabase(token.access_token, token.refresh_token, qbRealmId)
        .catch(e => console.error('Supabase token save error:', e));
    } catch (e) {
      console.error('QB token refresh failed:', e.message);
      return res.status(503).json({ error: 'QB token expired', reconnect: '/connect' });
    }
  }
  next();
}

app.use(['/qb', '/run-check', '/run-30-day-alert', '/run-monthly-invoices', '/overdue-invoices', '/30-day-alert', '/monthly-invoices'], ensureQBToken);

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
    await sendEmail(RECIPIENTS, 'Test Email from QuikBooks App', html);
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

  await sendEmail(RECIPIENTS, `Overdue Invoices — ${invoices.length} unpaid ($${totalBalance.toFixed(2)})`, html);
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

  await sendEmail(RECIPIENTS, 'Action Required: Invoices 30+ Days Overdue', html);
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

  await sendEmail(RECIPIENTS, `Mi Casa — Your Invoice for ${nextMonthLabel} is Ready`, html);
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

  await sendEmail(RECIPIENTS, 'KanCare Billing Deadline Reminder', html);
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


app.get('/assistant', (req, res) => {
  res.sendFile(__dirname + '/assistant.html');
});

app.post('/api/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;

    // Inject live QB customer list into system prompt
    let customerSection;
    try {
      const names = await getActiveCustomers();
      const lines = names.map(name => {
        const rate = RESIDENT_RATES[name];
        return rate
          ? `- ${name} — $${Number(rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}/month`
          : `- ${name}`;
      });
      customerSection = `## Active Residents (pulled live from QuickBooks)\n${lines.join('\n')}`;
    } catch (e) {
      customerSection = '## Active Residents\nCustomer list unavailable — QB token may need refresh.';
    }

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

    const INVOICE_KEYWORDS = ['create invoice', 'create invoices', 'make invoice', 'invoices for', 'bill residents', 'monthly invoices'];
    const userMsg = (messages[messages.length - 1]?.content || '').toLowerCase();
    const intent = INVOICE_KEYWORDS.some(kw => userMsg.includes(kw)) ? 'create-invoices' : null;

    res.json({ text, intent });
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

    const [custData, existingData] = await Promise.all([
      qbQuery('SELECT * FROM Customer WHERE Active = true MAXRESULTS 100'),
      qbQuery(`SELECT * FROM Invoice WHERE TxnDate >= '${firstDay}' AND TxnDate <= '${lastDay}' MAXRESULTS 100`)
    ]);

    const customers = custData.QueryResponse?.Customer || [];
    const existingInvoices = existingData.QueryResponse?.Invoice || [];
    const invoicedCustomerIds = new Set(existingInvoices.map(inv => inv.CustomerRef?.value));

    const preview = Object.entries(RESIDENT_RATES).map(([name, amount]) => {
      const customer = customers.find(c =>
        c.DisplayName?.toLowerCase() === name.toLowerCase() ||
        c.FullyQualifiedName?.toLowerCase() === name.toLowerCase()
      );
      const customerId = customer?.Id || null;
      return {
        name,
        customerId,
        amount,
        invoiceDate,
        dueDate,
        alreadyInvoiced: customerId ? invoicedCustomerIds.has(customerId) : false
      };
    });

    const total = Object.values(RESIDENT_RATES).reduce((a, b) => a + b, 0);
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const base = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
  console.log(`Server running at ${base}`);
  console.log(`QuickBooks connect: ${base}/connect`);
  console.log('Scheduled jobs handled by GitHub Actions');
});