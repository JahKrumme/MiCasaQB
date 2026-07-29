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
  // Verifies MiCasaCRM's (formerly the Hub's) signed service assertions on
  // /internal/* (src/middleware/internalAuth.ts). Optional so this app still
  // boots and works standalone with it unset — those routes simply refuse
  // (503) until it's configured. Must match the CRM's own
  // FINANCE_INTERNAL_SECRET.
  FINANCE_INTERNAL_SECRET?: string;
  // Non-secret: the CRM's own public origin. Used only by the CRM-initiated
  // OAuth branch (GET /api/qbo/callback's `svc:`-prefixed state) to redirect
  // the browser back to /finance/settings inside the CRM instead of this
  // app's own index.html. Optional — the CRM-initiated OAuth flow reports
  // 'not_configured' until it's set; QuikBooks' own standalone OAuth flow is
  // unaffected either way.
  CRM_BASE_URL?: string;
}
