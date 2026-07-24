import { Hono } from 'hono';
import type { AppEnv } from '../honoTypes';
import { requireAuth, blockIfPasswordChangeRequired } from '../middleware/auth';
import { requireSameOrigin } from '../middleware/security';
import { groqChatCompletion, type ChatMessage } from '../lib/groq';
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

chatRoutes.post('/', requireAuth, blockIfPasswordChangeRequired, requireSameOrigin, async c => {
  try {
    const { messages, system, mode } = (await c.req.json()) as { messages: ChatMessage[]; system: string; mode: string };
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
    console.error('[CHAT ERROR]', e instanceof Error ? e.name : 'unknown');
    return c.json({ error: 'The assistant is temporarily unavailable. Please try again.' }, 500);
  }
});
