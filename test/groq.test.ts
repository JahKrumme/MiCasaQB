import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv } from './helpers/testEnv';
import { groqChatCompletion, GroqError } from '../src/lib/groq';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const messages = [{ role: 'user' as const, content: 'How do I record a payment?' }];

describe('groqChatCompletion', () => {
  it('throws a missing_key GroqError and never calls fetch when GROQ_API_KEY is absent', async () => {
    const env = createTestEnv({ GROQ_API_KEY: undefined });
    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({ name: 'GroqError', category: 'missing_key' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the message content on a successful response', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Go to Sales > Invoices.' } }] }), { status: 200 })
    );

    const result = await groqChatCompletion(env, messages);
    expect(result).toBe('Go to Sales > Invoices.');

    // The key must reach Groq via the Authorization header, never the body.
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init.headers.Authorization).toBe(`Bearer ${env.GROQ_API_KEY}`);
    expect(init.body).not.toContain(env.GROQ_API_KEY);
  });

  it('categorizes invalid credentials (401) as http_error and surfaces the status', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } }), { status: 401 })
    );

    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({
      name: 'GroqError',
      category: 'http_error',
      status: 401
    });
  });

  it('categorizes an unavailable/decommissioned model (404) as http_error', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'model not found', code: 'model_not_found' } }), { status: 404 })
    );

    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({ name: 'GroqError', category: 'http_error', status: 404 });
  });

  it('categorizes a 429 rate-limit response as http_error with status 429', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429 }));

    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({ name: 'GroqError', category: 'http_error', status: 429 });
  });

  it('handles a non-JSON error body from Groq without throwing a secondary error', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({ name: 'GroqError', category: 'http_error', status: 502 });
  });

  it('categorizes a malformed (but 200 OK) response body as invalid_response', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 }));

    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({ name: 'GroqError', category: 'invalid_response' });
  });

  it('categorizes a non-JSON 200 response as invalid_response', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({ name: 'GroqError', category: 'invalid_response' });
  });

  it('times out via AbortController and categorizes as timeout', async () => {
    vi.useFakeTimers();
    const env = createTestEnv();
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        })
    );

    const promise = groqChatCompletion(env, messages);
    const assertion = expect(promise).rejects.toMatchObject({ name: 'GroqError', category: 'timeout' });
    await vi.advanceTimersByTimeAsync(20_000);
    await assertion;
  });

  it('categorizes a plain network failure (not an abort) as network', async () => {
    const env = createTestEnv();
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    await expect(groqChatCompletion(env, messages)).rejects.toMatchObject({ name: 'GroqError', category: 'network' });
  });

  it('never leaks the API key in a thrown error message', async () => {
    const env = createTestEnv();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { message: 'bad' } }), { status: 500 }));

    try {
      await groqChatCompletion(env, messages);
      throw new Error('expected groqChatCompletion to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(GroqError);
      expect((e as Error).message).not.toContain(env.GROQ_API_KEY);
    }
  });
});
