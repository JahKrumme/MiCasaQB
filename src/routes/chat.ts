import { Hono, type Context } from 'hono';
import type { AppEnv } from '../honoTypes';
import { requireAuth, blockIfPasswordChangeRequired } from '../middleware/auth';
import { requireSameOrigin } from '../middleware/security';
import { groqChatCompletion, GroqError, GROQ_MODEL, type ChatMessage } from '../lib/groq';
import { TokenRepository } from '../lib/tokenRepository';
import { getActiveCustomerNames, getResidentRates } from './qboApi';

export const chatRoutes = new Hono<AppEnv>();

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
];
const INVOICE_KEYWORDS = ['create invoice', 'make invoice', 'invoices for', 'monthly invoices', 'bill residents'];
const PAYMENT_KEYWORDS = ['record payment', 'record a payment', 'received payment', 'payment from', 'payment for', 'log payment'];
const RESIDENT_KEYWORDS = ['add resident', 'new resident', 'add client', 'move in'];
const OVERDUE_KEYWORDS = ['overdue', 'unpaid', 'who owes', 'outstanding'];

export const MAX_MESSAGE_LENGTH = 4000;
export const MAX_MESSAGES = 50;
const VALID_ROLES = new Set(['system', 'user', 'assistant']);

interface ChatRequestBody {
  messages: ChatMessage[];
  system: string;
  mode: string;
}

/** Pure validator so it can be exercised directly from tests. */
export function validateChatRequest(body: unknown): { ok: true; data: ChatRequestBody } | { ok: false; error: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'Request body must be a JSON object.' };
  }
  const { messages, system, mode } = body as Record<string, unknown>;

  if (typeof system !== 'string') {
    return { ok: false, error: 'Missing or invalid "system" field.' };
  }
  if (typeof mode !== 'string') {
    return { ok: false, error: 'Missing or invalid "mode" field.' };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: 'Missing or empty "messages" array.' };
  }
  if (messages.length > MAX_MESSAGES) {
    return { ok: false, error: `Too many messages in conversation (max ${MAX_MESSAGES}).` };
  }
  for (const m of messages) {
    if (typeof m !== 'object' || m === null) {
      return { ok: false, error: 'Each message must be an object.' };
    }
    const { role, content } = m as Record<string, unknown>;
    if (typeof role !== 'string' || !VALID_ROLES.has(role)) {
      return { ok: false, error: 'Each message must have a valid "role".' };
    }
    if (typeof content !== 'string' || content.length === 0) {
      return { ok: false, error: 'Each message must have non-empty "content".' };
    }
    if (content.length > MAX_MESSAGE_LENGTH) {
      return { ok: false, error: `Message content exceeds the ${MAX_MESSAGE_LENGTH}-character limit.` };
    }
  }

  return { ok: true, data: { messages: messages as ChatMessage[], system, mode } };
}

/**
 * Structured, secret-free diagnostic log for chat failures. Never includes
 * the Groq API key, chat content, or a full upstream response body.
 */
function logChatError(c: Context<AppEnv>, opts: { error: unknown; bodyValid: boolean }) {
  const { error, bodyValid } = opts;
  const apiKey = c.env.GROQ_API_KEY;
  const entry: Record<string, unknown> = {
    bodyValid,
    sessionValid: !!c.get('user'),
    hasApiKey: !!apiKey,
    apiKeyLength: apiKey?.length ?? 0,
    model: GROQ_MODEL
  };

  if (error instanceof GroqError) {
    entry.category = error.category;
    entry.status = error.status;
    entry.requestId = error.requestId;
    entry.message = error.message;
  } else {
    entry.category = 'unknown';
    entry.message = error instanceof Error ? error.message : 'non-Error thrown';
  }

  console.error('[CHAT ERROR]', JSON.stringify(entry));
}

function chatErrorResponse(error: unknown): { body: { error: string }; status: 400 | 401 | 429 | 502 | 503 | 504 } {
  if (error instanceof GroqError) {
    switch (error.category) {
      case 'missing_key':
        return { body: { error: 'The assistant is not configured yet. Please contact an administrator.' }, status: 503 };
      case 'timeout':
        return { body: { error: 'The assistant took too long to respond. Please try again.' }, status: 504 };
      case 'network':
        return { body: { error: 'Could not reach the assistant. Please try again.' }, status: 502 };
      case 'http_error':
        if (error.status === 429) {
          return { body: { error: 'The assistant is receiving too many requests right now. Please try again shortly.' }, status: 429 };
        }
        if (error.status === 401 || error.status === 403) {
          return { body: { error: 'The assistant is not configured correctly. Please contact an administrator.' }, status: 503 };
        }
        return { body: { error: 'The assistant is temporarily unavailable. Please try again.' }, status: 502 };
      case 'invalid_response':
        return { body: { error: 'The assistant returned an unexpected response. Please try again.' }, status: 502 };
    }
  }
  return { body: { error: 'The assistant is temporarily unavailable. Please try again.' }, status: 502 };
}

chatRoutes.post('/', requireAuth, blockIfPasswordChangeRequired, requireSameOrigin, async c => {
  let bodyValid = false;
  try {
    const rawBody = await c.req.json().catch(() => null);
    const validation = validateChatRequest(rawBody);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }
    bodyValid = true;
    const { messages, system, mode } = validation.data;
    const userContent = messages[messages.length - 1]?.content || '';
    const userMsgLower = userContent.toLowerCase();

    // QuickBooks customer/rate data feeds both intent detection and the system
    // prompt. If QB isn't connected yet, degrade gracefully instead of failing.
    let customerNames: string[] = [];
    let customerRates: Record<string, number> = {};
    let customerSection: string;

    const realmId = await new TokenRepository(c.env).getActiveRealmId();

    if (realmId) {
      try {
        const [names, rates] = await Promise.all([getActiveCustomerNames(c.env, realmId), getResidentRates(c.env, realmId)]);
        customerNames = names;
        customerRates = rates;
        const lines = names.map(name => {
          const rate = rates[name];
          return rate ? `- ${name}: $${Number(rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : `- ${name}: rate unknown`;
        });
        customerSection = `## Active Residents and Current Monthly Rates (pulled live from QuickBooks)\n${lines.join('\n')}`;
      } catch {
        customerSection = '## Active Residents\nCustomer list unavailable — QB token may need refresh.';
      }
    } else {
      customerSection = '## Active Residents\nQuickBooks is not connected yet.';
    }

    let intent: string | null = null;
    let paymentData: { customerName: string | null; amount: number | null } | null = null;

    const hasInvoiceWord = userMsgLower.includes('invoice') || userMsgLower.includes('invoices');
    const hasMonth = MONTHS.some(m => userMsgLower.includes(m));
    const hasPaid = userMsgLower.includes('paid') && !userMsgLower.includes('unpaid');

    if (INVOICE_KEYWORDS.some(kw => userMsgLower.includes(kw)) || (hasInvoiceWord && hasMonth)) {
      intent = 'create-invoices';
    } else if (PAYMENT_KEYWORDS.some(kw => userMsgLower.includes(kw)) || hasPaid) {
      intent = 'record-payment';
      const amountMatch = userContent.match(/\$?([\d,]+(?:\.\d{2})?)/);
      const extractedAmount = amountMatch ? parseFloat(amountMatch[1]!.replace(/,/g, '')) : null;
      const extractedName = customerNames.find(name => userMsgLower.includes(name.toLowerCase())) || null;
      const rateAmount = extractedName ? customerRates[extractedName] ?? null : null;
      paymentData = { customerName: extractedName, amount: extractedAmount || rateAmount };
    } else if (RESIDENT_KEYWORDS.some(kw => userMsgLower.includes(kw))) {
      intent = 'add-resident';
    } else if (OVERDUE_KEYWORDS.some(kw => userMsgLower.includes(kw))) {
      intent = 'overdue-summary';
    }

    if (intent && mode !== 'access') {
      return c.json({ text: null, intent, paymentData });
    }

    const augmentedSystem = system + '\n\n' + customerSection;
    const text = await groqChatCompletion(c.env, [{ role: 'system', content: augmentedSystem }, ...messages]);
    return c.json({ text, intent: null, paymentData: null });
  } catch (e) {
    logChatError(c, { error: e, bodyValid });
    const { body, status } = chatErrorResponse(e);
    return c.json(body, status);
  }
});
