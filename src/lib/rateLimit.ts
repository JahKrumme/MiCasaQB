import type { Env } from '../env';

/**
 * Fixed-window rate limiter backed by D1. Sufficient for a small internal app
 * (D1/SQLite serializes writes per database, so counts stay accurate without
 * extra locking). Returns true if the request should be allowed.
 */
export async function checkRateLimit(env: Env, key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowStart = nowSeconds - (nowSeconds % windowSeconds);

  const row = await env.DB.prepare(`SELECT count, window_start FROM rate_limits WHERE bucket_key = ?`)
    .bind(key)
    .first<{ count: number; window_start: number }>();

  if (!row || row.window_start !== windowStart) {
    await env.DB.prepare(
      `INSERT INTO rate_limits (bucket_key, count, window_start) VALUES (?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET count = 1, window_start = excluded.window_start`
    )
      .bind(key, windowStart)
      .run();
    return true;
  }

  if (row.count >= limit) return false;

  await env.DB.prepare(`UPDATE rate_limits SET count = count + 1 WHERE bucket_key = ?`).bind(key).run();
  return true;
}
