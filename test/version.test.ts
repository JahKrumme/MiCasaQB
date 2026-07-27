import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';

describe('GET /api/version', () => {
  it('is reachable without authentication and returns version + builtAt', async () => {
    const env = createTestEnv({ APP_VERSION: 'abc1234', APP_BUILT_AT: '2026-01-02T03:04:05.000Z' });
    const res = await app.fetch(new Request('https://test.example.com/api/version'), env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ version: 'abc1234', builtAt: '2026-01-02T03:04:05.000Z' });
  });

  it('is never cached', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request('https://test.example.com/api/version'), env);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('falls back to "dev" / null when APP_VERSION or APP_BUILT_AT are unset', async () => {
    const env = createTestEnv({ APP_VERSION: '', APP_BUILT_AT: '' });
    const res = await app.fetch(new Request('https://test.example.com/api/version'), env);
    const body = (await res.json()) as { version: string; builtAt: string | null };
    expect(body.version).toBe('dev');
    expect(body.builtAt).toBeNull();
  });

  it('never exposes secrets, env internals, or DB state', async () => {
    const env = createTestEnv();
    const res = await app.fetch(new Request('https://test.example.com/api/version'), env);
    const rawBody = await res.text();

    // Nothing beyond {version, builtAt} — no secret values, no key names.
    expect(Object.keys(JSON.parse(rawBody)).sort()).toEqual(['builtAt', 'version']);
    expect(rawBody).not.toContain(env.TOKEN_ENCRYPTION_KEY);
    expect(rawBody).not.toContain(env.SESSION_SECRET);
    expect(rawBody).not.toContain(env.INTUIT_CLIENT_SECRET);
    expect(rawBody).not.toContain(env.GROQ_API_KEY);
    expect(rawBody).not.toContain(env.GMAIL_REFRESH_TOKEN);
    expect(rawBody).not.toMatch(/CRON_SECRET|SESSION_SECRET|TOKEN_ENCRYPTION_KEY|CLIENT_SECRET|API_KEY/i);
    expect(rawBody).not.toMatch(/\/(Users|home|src|node_modules)\//);
  });
});
