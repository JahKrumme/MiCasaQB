import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from '../honoTypes';
import type { AuditAction } from '../lib/auditLog';
import { requireCronSecret } from '../middleware/auth';
import { TokenRepository } from '../lib/tokenRepository';
import { recordAuditEvent } from '../lib/auditLog';
import {
  runKanCareReminder, runMonthlyInvoices, runOverdueCheck, run30DayAlert, diagnoseOverdueDigest,
  diagnose30DayAlert, diagnoseMonthlyInvoices, diagnoseKanCareReminder, type ReportResult
} from '../lib/reports';

// Triggered by GitHub Actions on a schedule (see .github/workflows/*.yml),
// authenticated with a shared secret since there is no browser session here.
export const cronRoutes = new Hono<AppEnv>();
cronRoutes.use('*', requireCronSecret);

// Shared response mapping for every job below — 'no-token'/'token-error'
// (a QuickBooks problem) -> 503; 'gmail-error' with 'not_configured' -> 503
// (a setup gap, same convention as /internal/gmail/test-send); every other
// Gmail category (invalid_client/invalid_grant/rate_limited/transient/
// unknown_auth_error/send_failed) -> 502 (a real upstream failure); 'ok' ->
// 200. Never a bare, uncategorized 500 for a result this typed.
function respondToReportResult(c: Context<AppEnv>, label: string, result: ReportResult, dryRun: boolean) {
  if (result.status === 'no-token' || result.status === 'token-error') {
    return c.json({ status: result.status, reconnect: '/api/qbo/connect' }, 503);
  }
  if (result.status === 'gmail-error') {
    console.error(`[CRON ${label}] failed, runId=`, result.runId, 'status=failure', 'errorCategory=', result.errorCategory);
    return c.json({ status: result.status, errorCategory: result.errorCategory, runId: result.runId }, result.errorCategory === 'not_configured' ? 503 : 502);
  }
  console.log(`[CRON ${label}] runId=`, result.runId, 'reminderCount=', result.count, 'status=', dryRun ? 'dry-run' : 'success');
  return c.json(result);
}

// Defense-in-depth for every job below: each run* function already catches
// every failure mode it knows about (QuickBooks token issues, Gmail
// auth/send failures) — this only catches something genuinely unexpected,
// so a scheduled run can never again fail with nothing recorded anywhere
// (the bug the original Daily Overdue Check fix addressed). Never the raw
// exception message. A dry run never audits (nothing was attempted for
// real), matching every job's own dry-run discipline.
async function runScheduledJobRoute(c: Context<AppEnv>, label: string, failedAction: AuditAction, dryRun: boolean, run: () => Promise<ReportResult>) {
  try {
    const result = await run();
    return respondToReportResult(c, label, result, dryRun);
  } catch (e) {
    console.error(`[CRON ${label}] unexpected failure:`, e instanceof Error ? e.name : 'unknown');
    if (!dryRun) {
      await recordAuditEvent(c.env, { actor: null, action: failedAction, metadata: { errorCategory: 'unknown' } }).catch(auditErr => {
        console.error(`[CRON ${label}] failed to record failure audit event,`, auditErr instanceof Error ? auditErr.message : 'unknown');
      });
    }
    return c.json({ status: 'gmail-error', errorCategory: 'unknown' }, 500);
  }
}

// `?diagnostic=true` runs the REAL send path — real QuickBooks query, the
// real digest payload, real recipient validation, a real Gmail token
// refresh — and stops immediately before the network call that would
// actually deliver the email. Never sends anything under any outcome.
// Purely diagnostic (never audited, never affects the "last run" status
// Integration Health reads) — use this to investigate a failure without
// risking a duplicate real send. Checked before `dryRun` so the two never
// interact; `dryRun`'s existing contract/response shape is unchanged.
cronRoutes.post('/overdue-check', async c => {
  if (c.req.query('diagnostic') === 'true') {
    const realmId = await new TokenRepository(c.env).getActiveRealmId();
    return c.json(await diagnoseOverdueDigest(c.env, realmId));
  }
  const dryRun = c.req.query('dryRun') === 'true';
  return runScheduledJobRoute(c, 'overdue-check', 'scheduled_overdue_check_failed', dryRun, async () => {
    const realmId = await new TokenRepository(c.env).getActiveRealmId();
    return runOverdueCheck(c.env, realmId, { dryRun });
  });
});

cronRoutes.post('/30-day-alert', async c => {
  if (c.req.query('diagnostic') === 'true') {
    const realmId = await new TokenRepository(c.env).getActiveRealmId();
    return c.json(await diagnose30DayAlert(c.env, realmId));
  }
  const dryRun = c.req.query('dryRun') === 'true';
  return runScheduledJobRoute(c, '30-day-alert', 'scheduled_30_day_alert_failed', dryRun, async () => {
    const realmId = await new TokenRepository(c.env).getActiveRealmId();
    return run30DayAlert(c.env, realmId, { dryRun });
  });
});

cronRoutes.post('/monthly-invoices', async c => {
  if (c.req.query('diagnostic') === 'true') {
    const realmId = await new TokenRepository(c.env).getActiveRealmId();
    return c.json(await diagnoseMonthlyInvoices(c.env, realmId));
  }
  const dryRun = c.req.query('dryRun') === 'true';
  return runScheduledJobRoute(c, 'monthly-invoices', 'scheduled_monthly_invoices_failed', dryRun, async () => {
    const realmId = await new TokenRepository(c.env).getActiveRealmId();
    return runMonthlyInvoices(c.env, realmId, { dryRun });
  });
});

cronRoutes.post('/kancare-reminder', async c => {
  if (c.req.query('diagnostic') === 'true') {
    return c.json(await diagnoseKanCareReminder(c.env));
  }
  const dryRun = c.req.query('dryRun') === 'true';
  return runScheduledJobRoute(c, 'kancare-reminder', 'scheduled_kancare_reminder_failed', dryRun, async () => runKanCareReminder(c.env, { dryRun }));
});
