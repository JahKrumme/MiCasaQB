import { Hono } from 'hono';
import type { AppEnv } from '../honoTypes';
import { requireCronSecret } from '../middleware/auth';
import { TokenRepository } from '../lib/tokenRepository';
import { recordAuditEvent } from '../lib/auditLog';
import { runKanCareReminder, runMonthlyInvoices, runOverdueCheck, run30DayAlert } from '../lib/reports';

// Triggered by GitHub Actions on a schedule (see .github/workflows/*.yml),
// authenticated with a shared secret since there is no browser session here.
export const cronRoutes = new Hono<AppEnv>();
cronRoutes.use('*', requireCronSecret);

// `?dryRun=true` computes the real invoice count without ever calling
// Gmail — safe to hit against production any time (e.g.
// daily-check.yml's workflow_dispatch input, or a manual curl) to verify
// the endpoint without risking a real reminder email. The real scheduled
// cron trigger never sets this — it always has its normal, real effect.
cronRoutes.post('/overdue-check', async c => {
  const dryRun = c.req.query('dryRun') === 'true';
  try {
    const realmId = await new TokenRepository(c.env).getActiveRealmId();
    const result = await runOverdueCheck(c.env, realmId, { dryRun });
    if (result.status === 'no-token' || result.status === 'token-error') {
      return c.json({ status: result.status, reconnect: '/api/qbo/connect' }, 503);
    }
    if (result.status === 'gmail-error') {
      console.error('[CRON overdue-check] failed, runId=', result.runId, 'status=failure', 'errorCategory=', result.errorCategory);
      // Same convention as /internal/gmail/test-send: 'not_configured' is a
      // setup gap (503, matches the no-token/token-error branches above),
      // 'auth_failed'/'send_failed' are real upstream failures (502).
      return c.json({ status: result.status, errorCategory: result.errorCategory, runId: result.runId }, result.errorCategory === 'not_configured' ? 503 : 502);
    }
    console.log('[CRON overdue-check] runId=', result.runId, 'reminderCount=', result.count, 'status=', dryRun ? 'dry-run' : 'success');
    return c.json(result);
  } catch (e) {
    // Defense-in-depth: runOverdueCheck already catches every failure mode
    // it knows about (QuickBooks token issues, Gmail auth/send failures) —
    // this only catches something genuinely unexpected, so a scheduled run
    // can never again fail with nothing recorded anywhere (the bug this
    // whole route was fixed for). Never the raw exception message.
    console.error('[CRON overdue-check] unexpected failure:', e instanceof Error ? e.name : 'unknown');
    if (!dryRun) {
      await recordAuditEvent(c.env, { actor: null, action: 'scheduled_overdue_check_failed', metadata: { errorCategory: 'unknown' } });
    }
    return c.json({ status: 'gmail-error', errorCategory: 'unknown' }, 500);
  }
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
