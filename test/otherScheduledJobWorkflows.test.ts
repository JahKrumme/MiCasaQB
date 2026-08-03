import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readWorkflow(file: string): string {
  return readFileSync(path.join(__dirname, `../.github/workflows/${file}`), 'utf-8');
}

const WORKFLOWS = [
  { file: '30-day-alert.yml', cron: "'0 13 \\* \\* 1'", endpoint: '30-day-alert', hasRetry: true },
  { file: 'monthly-invoices.yml', cron: "'0 13 20 \\* \\*'", endpoint: 'monthly-invoices', hasRetry: false },
  { file: 'kancare-reminder.yml', cron: "'0 13 25 \\* \\*'", endpoint: 'kancare-reminder', hasRetry: false }
] as const;

for (const wf of WORKFLOWS) {
  describe(`GitHub Actions ${wf.file} workflow`, () => {
    const workflowSource = readWorkflow(wf.file);

    it('runs on its own schedule, unchanged, and supports manual dispatch', () => {
      expect(workflowSource).toMatch(new RegExp(`cron:\\s*${wf.cron}`));
      expect(workflowSource).toMatch(/workflow_dispatch:/);
    });

    it('exposes dryRun and diagnostic inputs, both defaulting to false', () => {
      expect(workflowSource).toMatch(/dryRun:/);
      expect(workflowSource).toMatch(/diagnostic:/);
      const defaults = workflowSource.match(/default:\s*false/g) ?? [];
      expect(defaults.length).toBeGreaterThanOrEqual(2);
    });

    it('diagnostic takes priority over dryRun when both are set', () => {
      const runBlock = workflowSource.split('run: |')[1]!;
      const diagnosticIndex = runBlock.indexOf('inputs.diagnostic');
      const dryRunIndex = runBlock.indexOf('inputs.dryRun');
      expect(diagnosticIndex).toBeGreaterThan(-1);
      expect(diagnosticIndex).toBeLessThan(dryRunIndex);
    });

    it('the scheduled trigger never sets dryRun or diagnostic — only a manual dispatch can enable either', () => {
      const scheduleBlock = workflowSource.split('workflow_dispatch:')[0]!;
      expect(scheduleBlock).not.toMatch(/dryRun/);
      expect(scheduleBlock).not.toMatch(/diagnostic/);
    });

    it('passes the shared secret via X-Cron-Secret, from GitHub secrets only, and never echoes it', () => {
      expect(workflowSource).toMatch(/X-Cron-Secret:\s*\$\{\{\s*secrets\.CRON_SECRET\s*\}\}/);
      expect(workflowSource).not.toMatch(/echo[^\n]*secrets\./);
    });

    it('calls the real endpoint on the configured Worker URL', () => {
      expect(workflowSource).toMatch(new RegExp(`\\$\\{\\{\\s*vars\\.WORKER_URL\\s*\\}\\}/api/cron/${wf.endpoint}`));
    });

    if (wf.hasRetry) {
      it('retries up to 3 times with a delay before failing the run', () => {
        expect(workflowSource).toMatch(/for i in \{1\.\.3\}/);
        expect(workflowSource).toMatch(/sleep 15/);
      });
    }
  });
}
