require('dotenv').config();
const express = require('express');
const OAuthClient = require('intuit-oauth');

const app = express();

const oauthClient = new OAuthClient({
  clientId: process.env.INTUIT_CLIENT_ID,
  clientSecret: process.env.INTUIT_CLIENT_SECRET,
  environment: process.env.INTUIT_ENVIRONMENT,
  redirectUri: process.env.INTUIT_REDIRECT_URI
});

app.get('/connect', (req, res) => {
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state: 'mi-casa-qb'
  });
  res.redirect(authUri);
});

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

app.listen(3000, () => {
  console.log('Server running — visit http://localhost:3000/connect');
});