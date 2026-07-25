import type { Env } from '../env';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

// llama-3.3-70b-versatile is on Groq's deprecation list (shutdown 2026-08-16,
// see https://console.groq.com/docs/deprecations) — moved to their
// recommended replacement ahead of that date rather than waiting for it to
// start failing again.
export const GROQ_MODEL = 'openai/gpt-oss-120b';

const REQUEST_TIMEOUT_MS = 20_000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export type GroqErrorCategory =
  | 'missing_key'
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'invalid_response';

/**
 * Carries only sanitized diagnostic fields — never the API key, never a raw
 * Groq response body. Safe to log in full from the route handler.
 */
export class GroqError extends Error {
  category: GroqErrorCategory;
  status?: number;
  requestId?: string;

  constructor(category: GroqErrorCategory, message: string, opts: { status?: number; requestId?: string } = {}) {
    super(message);
    this.name = 'GroqError';
    this.category = category;
    this.status = opts.status;
    this.requestId = opts.requestId;
  }
}

export async function groqChatCompletion(env: Env, messages: ChatMessage[]): Promise<string> {
  if (!env.GROQ_API_KEY) {
    throw new GroqError('missing_key', 'Chat assistant is not configured.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(GROQ_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        max_tokens: 1024
      }),
      signal: controller.signal
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new GroqError('timeout', `Groq request timed out after ${REQUEST_TIMEOUT_MS}ms.`);
    }
    throw new GroqError('network', e instanceof Error ? e.message : 'Network error contacting Groq.');
  } finally {
    clearTimeout(timeout);
  }

  const requestId = response.headers.get('x-request-id') ?? undefined;

  if (!response.ok) {
    // Groq error bodies can echo request content back — only surface the
    // top-level error type/code, never the full body.
    let sanitizedMessage = `Groq responded with HTTP ${response.status}.`;
    try {
      const errJson = (await response.json()) as { error?: { message?: string; type?: string; code?: string } };
      if (errJson?.error?.type || errJson?.error?.code) {
        sanitizedMessage += ` type=${errJson.error.type ?? 'unknown'} code=${errJson.error.code ?? 'unknown'}`;
      }
    } catch {
      // Non-JSON error body (HTML error page, empty body, etc.) — fall back
      // to the status-only message rather than throwing here.
    }
    throw new GroqError('http_error', sanitizedMessage, { status: response.status, requestId });
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new GroqError('invalid_response', 'Groq returned a non-JSON response body.', { status: response.status, requestId });
  }

  const content = (json as { choices?: { message?: { content?: string } }[] })?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new GroqError('invalid_response', 'Groq response was missing the expected choices[0].message.content field.', {
      status: response.status,
      requestId
    });
  }

  return content;
}
