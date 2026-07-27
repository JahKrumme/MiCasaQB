import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowSource = readFileSync(path.join(__dirname, '../.github/workflows/deploy-cloudflare.yml'), 'utf-8');

describe('GitHub Actions Cloudflare deploy workflow', () => {
  it('triggers on pushes to main and supports manual dispatch', () => {
    expect(workflowSource).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\n\s*-\s*main/);
    expect(workflowSource).toMatch(/workflow_dispatch:/);
  });

  it('never triggers on pull_request (no auto-deploy of untrusted PR code to production)', () => {
    // Checks for an actual `pull_request:` trigger key, not just the phrase
    // in an explanatory comment (this file's own header mentions it in prose).
    expect(workflowSource).not.toMatch(/^\s*pull_request:/m);
  });

  it('installs the locked Node version from .nvmrc via npm ci', () => {
    expect(workflowSource).toMatch(/node-version-file:\s*['"]\.nvmrc['"]/);
    expect(workflowSource).toMatch(/npm ci/);
  });

  it('runs typecheck, lint, test, and build before any deploy step', () => {
    const steps = ['npm run typecheck', 'npm run lint', 'npm test', 'npm run build'];
    const indices = steps.map(step => workflowSource.indexOf(step));
    for (const index of indices) expect(index).toBeGreaterThan(-1);
    const deployIndex = workflowSource.indexOf('wrangler-action');
    expect(deployIndex).toBeGreaterThan(-1);
    for (const index of indices) expect(index).toBeLessThan(deployIndex);
  });

  it('reads Cloudflare credentials from GitHub secrets, never hardcoded', () => {
    expect(workflowSource).toMatch(/apiToken:\s*\$\{\{\s*secrets\.CLOUDFLARE_API_TOKEN\s*\}\}/);
    expect(workflowSource).toMatch(/accountId:\s*\$\{\{\s*secrets\.CLOUDFLARE_ACCOUNT_ID\s*\}\}/);
    // No bare token-shaped literals anywhere in the file.
    expect(workflowSource).not.toMatch(/apiToken:\s*['"a-zA-Z0-9]/);
  });

  it('preserves vars/secrets already configured on the Worker (--keep-vars, no `wrangler secret` calls)', () => {
    expect(workflowSource).toMatch(/--keep-vars/);
    expect(workflowSource).not.toMatch(/wrangler secret (put|bulk|delete)/);
  });

  it('never echoes or prints a secret value', () => {
    expect(workflowSource).not.toMatch(/echo[^\n]*secrets\./);
  });

  it('restricts default GITHUB_TOKEN permissions to read-only', () => {
    expect(workflowSource).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });
});
