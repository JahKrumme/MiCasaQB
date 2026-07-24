import type { Env } from '../env';

const GROQ_CHAT_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export async function groqChatCompletion(env: Env, messages: ChatMessage[]): Promise<string> {
  if (!env.GROQ_API_KEY) throw new Error('Chat assistant is not configured');

  const response = await fetch(GROQ_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages,
      max_tokens: 1024
    })
  });

  if (!response.ok) {
    console.error('[GROQ ERROR] status=', response.status);
    throw new Error('Chat assistant request failed');
  }

  const json = (await response.json()) as { choices: { message: { content: string } }[] };
  return json.choices[0]?.message?.content ?? '(No response)';
}
