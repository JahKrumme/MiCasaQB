require('dotenv').config();
const express = require('express');
const OAuthClient = require('intuit-oauth');
const { google } = require('googleapis');
const cron = require('node-cron');

const app = express();

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

// QB token stored in memory after /connect flow
let qbRealmId = null;


// --- helpers ---

async function getGmailClient() {
  gmailAuth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: gmailAuth });
}

async function sendEmail(to, subject, html) {
  const gmail = await getGmailClient();
  const message = [
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

async function qbQuery(query) {
  const base = process.env.INTUIT_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  const url = `${base}/v3/company/${qbRealmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
  const response = await oauthClient.makeApiCall({ url });
  return JSON.parse(response.body);
}

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
    console.log('QB tokens stored in memory');
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
    await sendEmail('elijahkrumme@gmail.com', 'Test Email from QuikBooks App', html);
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

  await sendEmail('elijahkrumme@gmail.com', `Overdue Invoices — ${invoices.length} unpaid ($${totalBalance.toFixed(2)})`, html);
  console.log('Daily overdue check complete');
  return { status: 'ok', count: invoices.length, total: totalBalance };
}

// Fetch overdue invoices from QB and email them
app.get('/overdue-invoices', async (req, res) => {
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

  await sendEmail('elijahkrumme@gmail.com', 'Action Required: Invoices 30+ Days Overdue', html);
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

  await sendEmail('elijahkrumme@gmail.com', `Mi Casa — Your Invoice for ${nextMonthLabel} is Ready`, html);
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

// Daily 8 AM check — only sends overdue emails between the 6th and 15th
cron.schedule('0 8 * * *', () => {
  const day = new Date().getDate();
  if (day < 6 || day > 15) {
    console.log('Outside overdue reminder window');
    return;
  }
  console.log('Running daily overdue invoice check...');
  runOverdueCheck().catch(e => console.error('Cron job error:', e));
  run30DayAlert().catch(e => console.error('30-day cron error:', e));
});

// 20th of every month at 8 AM — sends next month's invoice notice
cron.schedule('0 8 20 * *', () => {
  console.log('Running monthly invoice notice...');
  runMonthlyInvoices().catch(e => console.error('Monthly cron error:', e));
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

  await sendEmail('elijahkrumme@gmail.com', 'KanCare Billing Deadline Reminder', html);
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

// 25th of every month at 8 AM
cron.schedule('0 8 25 * *', () => {
  console.log('Running KanCare billing reminder...');
  runKanCareReminder().catch(e => console.error('KanCare cron error:', e));
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('QuickBooks: http://localhost:3000/connect');
  console.log('Gmail: http://localhost:3000/gmail/connect');
  console.log('Test email: http://localhost:3000/send-test');
  console.log('Overdue invoices: http://localhost:3000/overdue-invoices');
  console.log('Manual check: http://localhost:3000/run-check');
  console.log('30-day alert: http://localhost:3000/run-30-day-alert');
  console.log('Monthly summary: http://localhost:3000/run-monthly-invoices');
  console.log('KanCare reminder: http://localhost:3000/run-kancare-reminder');
  console.log('Daily cron: 8:00 AM (6th-15th only) | Invoice notice: 20th | KanCare: 25th');
});