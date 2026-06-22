require('dotenv').config();
const express = require('express');
const OAuthClient = require('intuit-oauth');
const { google } = require('googleapis');

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

// --- helpers ---

async function getGmailClient() {
  gmailAuth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: gmailAuth });
}

async function sendEmail(to, subject, body) {
  const gmail = await getGmailClient();
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    body
  ].join('\n');
  const encoded = Buffer.from(message).toString('base64url');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

async function refreshQBToken() {
  oauthClient.setToken({ refresh_token: process.env.INTUIT_REFRESH_TOKEN });
  await oauthClient.refresh();
}

async function qbQuery(query) {
  await refreshQBToken();
  const realmId = process.env.INTUIT_REALM_ID;
  const base = process.env.INTUIT_ENVIRONMENT === 'sandbox'
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  const url = `${base}/v3/company/${realmId}/query?query=${encodeURIComponent(query)}&minorversion=65`;
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
    const realmId = req.query.realmId;
    const url = `https://sandbox-quickbooks.api.intuit.com/v3/company/${realmId}/query?query=SELECT * FROM Invoice MAXRESULTS 5&minorversion=65`;
    const response = await oauthClient.makeApiCall({ url });
    const data = JSON.parse(response.body);
    const invoices = data.QueryResponse.Invoice || [];

    if (invoices.length === 0) {
      res.send('Connected! No invoices found in sandbox yet.');
    } else {
      let output = `Connected! Found ${invoices.length} invoice(s):<br><br>`;
      invoices.forEach(inv => {
        output += `Invoice #${inv.DocNumber} | $${inv.TotalAmt} | Due: ${inv.DueDate} | Balance: $${inv.Balance}<br>`;
      });
      res.send(output);
    }
  } catch (e) {
    console.error('Error:', e);
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
    await sendEmail('elijahkrumme@gmail.com', 'Test Email from QuikBooks App', 'It works! Gmail API is connected.');
    res.send('Test email sent to elijahkrumme@gmail.com');
  } catch (e) {
    console.error('Send-test error:', e);
    res.status(500).send('Failed to send email: ' + e.message);
  }
});

// Fetch overdue invoices from QB and email them
app.get('/overdue-invoices', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const data = await qbQuery(`SELECT * FROM Invoice WHERE Balance > '0' AND DueDate < '${today}'`);
    const invoices = data.QueryResponse?.Invoice || [];

    if (invoices.length === 0) {
      res.send('No overdue invoices found.');
      return;
    }

    const lines = invoices.map(inv =>
      `Invoice #${inv.DocNumber} | Customer: ${inv.CustomerRef?.name || 'N/A'} | Due: ${inv.DueDate} | Balance: $${inv.Balance}`
    );
    const body = `Overdue Invoices as of ${today}:\n\n${lines.join('\n')}`;

    await sendEmail('elijahkrumme@gmail.com', `Overdue Invoices (${invoices.length})`, body);
    res.send(`Found ${invoices.length} overdue invoice(s). Email sent to elijahkrumme@gmail.com.<br><br>${lines.join('<br>')}`);
  } catch (e) {
    console.error('Overdue-invoices error:', e);
    res.status(500).send('Failed: ' + e.message);
  }
});

app.listen(3000, () => {
  console.log('Server running at http://localhost:3000');
  console.log('QuickBooks: http://localhost:3000/connect');
  console.log('Gmail: http://localhost:3000/gmail/connect');
  console.log('Test email: http://localhost:3000/send-test');
  console.log('Overdue invoices: http://localhost:3000/overdue-invoices');
});