import { describe, expect, it } from 'vitest';
import { checkRateLimit } from '../src/lib/rateLimit';
import { createTestEnv } from './helpers/testEnv';

describe('checkRateLimit', () => {
  it('allows requests under the limit and blocks once the limit is reached within the window', async () => {
    const env = createTestEnv();
    const key = `test:${crypto.randomUUID()}`;

    for (let i = 0; i < 3; i++) {
      expect(await checkRateLimit(env, key, 3, 300)).toBe(true);
    }
    expect(await checkRateLimit(env, key, 3, 300)).toBe(false);
  });

  it('tracks separate buckets independently', async () => {
    const env = createTestEnv();
    const keyA = `test:${crypto.randomUUID()}`;
    const keyB = `test:${crypto.randomUUID()}`;

    expect(await checkRateLimit(env, keyA, 1, 300)).toBe(true);
    expect(await checkRateLimit(env, keyA, 1, 300)).toBe(false);
    expect(await checkRateLimit(env, keyB, 1, 300)).toBe(true);
  });
});
