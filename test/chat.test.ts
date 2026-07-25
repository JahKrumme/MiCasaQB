import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { createTestEnv } from './helpers/testEnv';
import { createUser } from '../src/lib/users';
import { createSession, SESSION_COOKIE } from '../src/lib/session';
import { validateChatRequest, MAX_MESSAGE_LENGTH, MAX_MESSAGES } from '../src/routes/chat';

async function signIn(env: ReturnType<typeof createTestEnv>) {
  const user = await createUser(env, 'staff@micasacarehomes.example', 'a-very-strong-password-123', 'staff');
  const { token } = await createSession(env, user.id);
  return { user, cookie: `${SESSION_COOKIE}=${token}` };
}

function chatRequest(body: unknown, cookie?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return new Request('https://test.example.com/api/chat', { method: 'POST', headers, body: JSON.stringify(body) });
}

const validBody = {
  messages: [{ role: 'user', content: 'What is the tax deadline this quarter?' }],
  system: 'You are a helpful assistant.',
  mode: 'micasa'
};

describe('validateChatRequest', () => {
  it('accepts a well-formed request', () => {
    const result = validateChatRequest(validBody);
    expect(result.ok).toBe(true);
  });

  it('rejects a non-object body', () => {
    expect(validateChatRequest(null).ok).toBe(false);
    expect(validateChatRequest('nope').ok).toBe(false);
  });

  it('rejects a missing messages array', () => {
    const result = validateChatRequest({ system: 'x', mode: 'micasa' });
    expect(result.ok).toBe(false);
  });

  it('rejects an empty messages array', () => {
    const result = validateChatRequest({ ...validBody, messages: [] });
    expect(result.ok).toBe(false);
  });

  it('rejects too many messages', () => {
    const messages = Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'hi' }));
    const result = validateChatRequest({ ...validBody, messages });
    expect(result.ok).toBe(false);
  });

  it('rejects a message with an invalid role', () => {
    const result = validateChatRequest({ ...validBody, messages: [{ role: 'admin', content: 'hi' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects a message with empty content', () => {
    const result = validateChatRequest({ ...validBody, messages: [{ role: 'user', content: '' }] });
    expect(result.ok).toBe(false);
  });

  it('rejects a message exceeding the length limit', () => {
    const result = validateChatRequest({ ...validBody, messages: [{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }] });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing system field', () => {
    const result = validateChatRequest({ messages: validBody.messages, mode: 'micasa' });
    expect(result.ok).toBe(false);
  });

  it('rejects a missing mode field', () => {
    const result = validateChatRequest({ messages: validBody.messages, system: 'x' });
    expect(result.ok).toBe(false);
  });
});

describe('POST /api/chat', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    consoleErrorSpy.mockRestore();
  });

  it('rejects an unauthenticated request', async () => {
    const env = createTestEnv();
    const res = await app.fetch(chatRequest(validBody), env);
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an invalid request body for a signed-in user with a sanitized 400', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    const res = await app.fetch(chatRequest({ messages: [] }, cookie), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(typeof body.error).toBe('string');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a successful response for a valid authenticated request', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'The Q1 deadline is April 15.' } }] }), { status: 200 })
    );

    const res = await app.fetch(chatRequest(validBody, cookie), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { text?: string };
    expect(body.text).toBe('The Q1 deadline is April 15.');
  });

  it('returns a sanitized 503 when GROQ_API_KEY is missing', async () => {
    const env = createTestEnv({ GROQ_API_KEY: undefined });
    const { cookie } = await signIn(env);

    const res = await app.fetch(chatRequest(validBody, cookie), env);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a sanitized 503 on invalid Groq credentials (401)', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'Invalid API Key' } }), { status: 401 }));

    const res = await app.fetch(chatRequest(validBody, cookie), env);
    expect(res.status).toBe(503);
  });

  it('returns a sanitized 429 on a Groq rate-limit response', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));

    const res = await app.fetch(chatRequest(validBody, cookie), env);
    expect(res.status).toBe(429);
  });

  it('returns a sanitized 502 for an unavailable/decommissioned model error', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }), { status: 404 })
    );

    const res = await app.fetch(chatRequest(validBody, cookie), env);
    expect(res.status).toBe(502);
  });

  it('returns a sanitized 502 for a malformed Groq response body', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ nonsense: true }), { status: 200 }));

    const res = await app.fetch(chatRequest(validBody, cookie), env);
    expect(res.status).toBe(502);
  });

  it('returns a sanitized 504 when the upstream Groq request times out', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    // Exercises the same catch-path groq.ts hits once its internal
    // AbortController fires (covered with real fake-timer timing in
    // groq.test.ts) without re-running the full 20s timer here too.
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    fetchMock.mockRejectedValue(abortError);

    const res = await app.fetch(chatRequest(validBody, cookie), env);
    expect(res.status).toBe(504);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/took too long/i);
  });

  it('logs chat failures without ever including the API key, secrets, or a raw Groq body', async () => {
    const env = createTestEnv();
    const { cookie } = await signIn(env);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API Key', very_sensitive: 'sk-should-not-appear' } }), { status: 401 })
    );

    await app.fetch(chatRequest(validBody, cookie), env);

    expect(consoleErrorSpy).toHaveBeenCalled();
    const loggedArgs = consoleErrorSpy.mock.calls.flat().map(String).join(' ');
    expect(loggedArgs).not.toContain(env.GROQ_API_KEY);
    expect(loggedArgs).not.toContain(env.SESSION_SECRET);
    expect(loggedArgs).not.toContain(env.TOKEN_ENCRYPTION_KEY);
    expect(loggedArgs).not.toContain('sk-should-not-appear');
    // Structured, sanitized fields should be present instead.
    expect(loggedArgs).toContain('hasApiKey');
    expect(loggedArgs).toContain('apiKeyLength');
    expect(loggedArgs).toContain('bodyValid');
  });
});
