export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // Non-secret vars (wrangler.jsonc)
  INTUIT_ENVIRONMENT: string;
  APP_BASE_URL: string;
  // Stamped at deploy time (short git SHA / ISO build timestamp). Falls back
  // to "dev" locally so wrangler dev / tests don't need them set.
  APP_VERSION: string;
  APP_BUILT_AT: string;

  // Secrets (wrangler secret put ...)
  INTUIT_CLIENT_ID: string;
  INTUIT_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEY: string;
  SESSION_SECRET: string;
  GMAIL_CLIENT_ID?: string;
  GMAIL_CLIENT_SECRET?: string;
  GMAIL_REFRESH_TOKEN?: string;
  GROQ_API_KEY?: string;
  CRON_SECRET?: string;
}
