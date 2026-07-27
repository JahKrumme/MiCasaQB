import { describe, expect, it } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { createUser } from '../src/lib/users';
import { createSession, SESSION_COOKIE } from '../src/lib/session';

async function signIn(env: ReturnType<typeof createTestEnv>) {
  const user = await createUser(env, 'staff@micasacarehomes.example', 'a-very-strong-password-123', 'staff');
  const { token } = await createSession(env, user.id);
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

describe('PUT /api/auth/theme', () => {
  it('requires authentication', async () => {
    const env = createTestEnv();
    const res = await app.fetch(
      new Request('https://test.example.com/api/auth/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: 'dark' })
      }),
      env
    );
    expect(res.status).toBe(401);
  });

  it('rejects an invalid theme value', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    const res = await app.fetch(
      new Request('https://test.example.com/api/auth/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ theme: 'blue' })
      }),
      env
    );
    expect(res.status).toBe(400);
  });

  it('persists the preference and reflects it in /api/auth/session', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);

    const putRes = await app.fetch(
      new Request('https://test.example.com/api/auth/theme', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({ theme: 'dark' })
      }),
      env
    );
    expect(putRes.status).toBe(200);

    const sessionRes = await app.fetch(new Request('https://test.example.com/api/auth/session', { headers: { Cookie: cookie } }), env);
    const sessionBody = (await sessionRes.json()) as { themePreference: string };
    expect(sessionBody.themePreference).toBe('dark');
  });

  it('defaults new users to "system"', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    const sessionRes = await app.fetch(new Request('https://test.example.com/api/auth/session', { headers: { Cookie: cookie } }), env);
    const sessionBody = (await sessionRes.json()) as { themePreference: string };
    expect(sessionBody.themePreference).toBe('system');
  });
});
