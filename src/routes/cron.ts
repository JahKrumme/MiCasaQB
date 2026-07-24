import { Hono } from 'hono';
import type { AppEnv } from '../honoTypes';
import { requireCronSecret } from '../middleware/auth';
import { TokenRepository } from '../lib/tokenRepository';
import { runKanCareReminder, runMonthlyInvoices, runOverdueCheck, run30DayAlert } from '../lib/reports';

// Triggered by GitHub Actions on a schedule (see .github/workflows/*.yml),
// authenticated with a shared secret since there is no browser session here.
export const cronRoutes = new Hono<AppEnv>();
cronRoutes.use('*', requireCronSecret);

cronRoutes.post('/overdue-check', async c => {
  const realmId = await new TokenRepository(c.env).getActiveRealmId();
  const result = await runOverdueCheck(c.env, realmId);
  if (result.status === 'no-token' || result.status === 'token-error') {
    return c.json({ status: result.status, reconnect: '/api/qbo/connect' }, 503);
  }
  return c.json(result);
});

cronRoutes.post('/30-day-alert', async c => {
  const realmId = await new TokenRepository(c.env).getActiveRealmId();
  const result = await run30DayAlert(c.env, realmId);
  if (result.status === 'no-token' || result.status === 'token-error') {
    return c.json({ status: result.status, reconnect: '/api/qbo/connect' }, 503);
  }
  return c.json(result);
});

cronRoutes.post('/monthly-invoices', async c => {
  const realmId = await new TokenRepository(c.env).getActiveRealmId();
  const result = await runMonthlyInvoices(c.env, realmId);
  if (result.status === 'no-token' || result.status === 'token-error') {
    return c.json({ status: result.status, reconnect: '/api/qbo/connect' }, 503);
  }
  return c.json(result);
});

cronRoutes.post('/kancare-reminder', async c => {
  await runKanCareReminder(c.env);
  return c.json({ status: 'ok' });
});
