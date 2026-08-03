import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowSource = readFileSync(path.join(__dirname, '../.github/workflows/daily-check.yml'), 'utf-8');

describe('GitHub Actions Daily Overdue Check workflow', () => {
  it('runs on the 8AM CST schedule and supports manual dispatch', () => {
    expect(workflowSource).toMatch(/cron:\s*'0 13 \* \* \*'/);
    expect(workflowSource).toMatch(/workflow_dispatch:/);
  });

  it('exposes a dryRun input for safe manual verification, defaulting to false', () => {
    expect(workflowSource).toMatch(/dryRun:/);
    expect(workflowSource).toMatch(/default:\s*false/);
  });

  it('exposes a diagnostic input for full-path safe investigation, defaulting to false', () => {
    expect(workflowSource).toMatch(/diagnostic:/);
    expect(workflowSource).toMatch(/URL="\$\{URL\}\?diagnostic=true"/);
  });

  it('diagnostic takes priority over dryRun when both are set', () => {
    const runBlock = workflowSource.split('run: |')[1]!;
    const diagnosticIndex = runBlock.indexOf('inputs.diagnostic');
    const dryRunIndex = runBlock.indexOf('inputs.dryRun');
    expect(diagnosticIndex).toBeGreaterThan(-1);
    expect(diagnosticIndex).toBeLessThan(dryRunIndex);
  });

  it('the scheduled trigger never sets dryRun or diagnostic — only a manual dispatch can enable either', () => {
    // The cron trigger block itself carries no inputs at all (inputs only
    // exist under workflow_dispatch) — a scheduled run has no way to read
    // inputs.dryRun/inputs.diagnostic as anything other than empty/false.
    const scheduleBlock = workflowSource.split('workflow_dispatch:')[0]!;
    expect(scheduleBlock).not.toMatch(/dryRun/);
    expect(scheduleBlock).not.toMatch(/diagnostic/);
  });

  it('passes the shared secret via X-Cron-Secret, from GitHub secrets only', () => {
    expect(workflowSource).toMatch(/X-Cron-Secret:\s*\$\{\{\s*secrets\.CRON_SECRET\s*\}\}/);
  });

  it('calls the real overdue-check endpoint on the configured Worker URL', () => {
    expect(workflowSource).toMatch(/\$\{\{\s*vars\.WORKER_URL\s*\}\}\/api\/cron\/overdue-check/);
  });

  it('retries up to 3 times with a delay before failing the run', () => {
    expect(workflowSource).toMatch(/for i in \{1\.\.3\}/);
    expect(workflowSource).toMatch(/sleep 15/);
  });

  it('never echoes a secret value', () => {
    expect(workflowSource).not.toMatch(/echo[^\n]*secrets\./);
  });
});
