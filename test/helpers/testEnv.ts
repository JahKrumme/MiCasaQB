import type { Env } from '../../src/env';
import { createFakeD1 } from './fakeD1';

function randomBase64(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: createFakeD1(),
    ASSETS: { fetch: async () => new Response('not found', { status: 404 }) } as unknown as Fetcher,
    INTUIT_ENVIRONMENT: 'sandbox',
    APP_BASE_URL: 'https://test.example.com',
    APP_VERSION: 'test-version',
    APP_BUILT_AT: '2026-01-01T00:00:00.000Z',
    INTUIT_CLIENT_ID: 'test-client-id',
    INTUIT_CLIENT_SECRET: 'test-client-secret',
    TOKEN_ENCRYPTION_KEY: randomBase64(32),
    SESSION_SECRET: randomBase64(32),
    GMAIL_CLIENT_ID: 'test-gmail-client-id',
    GMAIL_CLIENT_SECRET: 'test-gmail-client-secret',
    GMAIL_REFRESH_TOKEN: 'test-gmail-refresh-token',
    GROQ_API_KEY: 'test-groq-key',
    CRON_SECRET: 'test-cron-secret',
    FINANCE_INTERNAL_SECRET: 'test-finance-internal-secret',
    ...overrides
  };
}
