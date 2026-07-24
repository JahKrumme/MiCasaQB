# Mi Casa QuickBooks Companion

An installable Progressive Web App for Mi Casa Care Homes staff to manage QuickBooks Online
invoicing, payments, and residents through a chat-style assistant — running entirely on
Cloudflare Workers, Static Assets, and D1. No Render, no Supabase.

See [MIGRATION_PLAN.md](./MIGRATION_PLAN.md) for the full architecture writeup, the reasoning
behind the token-refresh redesign, and what changed from the previous Render/Supabase/Express
version.

## Architecture

- **Frontend**: static HTML/CSS/JS in `public/`, served by Cloudflare Static Assets, installable
  as a PWA (manifest + service worker).
- **Backend**: a single Cloudflare Worker (`src/index.ts`, [Hono](https://hono.dev) router) serving
  everything under `/api/*`.
- **Database**: Cloudflare D1 (`migrations/`) — staff accounts, sessions, QuickBooks OAuth state,
  and AES-256-GCM-encrypted QuickBooks token bundles. No plaintext tokens are ever stored.
- **Secrets**: Intuit client credentials, the token encryption key, and the session secret exist
  only as Wrangler secrets — never in source, never sent to the browser.

## Prerequisites

- Node.js 20+
- A Cloudflare account (Workers + D1 are both usable on the free tier for this app's scale)
- An Intuit developer app (for QuickBooks OAuth) with both a `workers.dev` and your production
  redirect URI registered
- (Optional) a Gmail OAuth app + refresh token, and a Groq API key, if you want the report emails
  and AI chat fallback to work

## 1. Install dependencies

```bash
npm install
```

## 2. Create the D1 database

```bash
npm run db:create
```

This prints a `database_id`. Copy it into `wrangler.jsonc` under `d1_databases[0].database_id`
(replacing `REPLACE_WITH_D1_DATABASE_ID`).

## 3. Apply migrations

```bash
# Local (used by `wrangler dev` / `npm run dev`)
npm run db:migrate:local

# Remote (production database)
npm run db:migrate:remote
```

## 4. Configure local secrets

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars` and fill in real values. Generate the encryption key and session secret with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`.dev.vars` is gitignored and loaded automatically by `wrangler dev` — never commit it.

## 5. Create your first administrator account

```bash
node scripts/create-admin.mjs you@micasacarehomes.com "a-strong-password-1234" --admin
```

By default this targets the **local** D1 database. Add `--remote` once you're ready to create the
production admin account (after step 8's remote migrations have been applied and remote secrets
are set).

## 6. Run locally

```bash
npm run dev
```

This starts `wrangler dev`, serving both the Worker (`/api/*`) and the static frontend from
`public/` at `http://localhost:8787`. Sign in at `/login.html` with the account from step 5.

## 7. "Building" the frontend

There is no bundler/build step for the frontend — `public/` is served as-is by Cloudflare Static
Assets. `npm run build` runs a TypeScript type-check of the Worker source (`tsc --noEmit`);
Wrangler itself bundles `src/index.ts` at deploy time.

## 8. Add production secrets

```bash
npx wrangler secret put INTUIT_CLIENT_ID
npx wrangler secret put INTUIT_CLIENT_SECRET
npx wrangler secret put TOKEN_ENCRYPTION_KEY
npx wrangler secret put SESSION_SECRET
npx wrangler secret put GMAIL_CLIENT_ID
npx wrangler secret put GMAIL_CLIENT_SECRET
npx wrangler secret put GMAIL_REFRESH_TOKEN
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put CRON_SECRET
```

List what's configured (values are never shown) with:

```bash
npm run secrets:list
```

## 9. Deploy

```bash
npm run deploy
```

This deploys the Worker and publishes `public/` as static assets in one shot. Wrangler prints the
`*.workers.dev` URL on first deploy.

## 10. Set the Intuit redirect URI

The callback path is always `/api/qbo/callback`. Register **both** of these in your Intuit app's
redirect URIs (the `workers.dev` one lets you test before the custom domain is live):

- `https://<your-subdomain>.workers.dev/api/qbo/callback`
- `https://qb-assistant.micasacarehomes.com/api/qbo/callback` (production, once the custom domain
  is attached to the Worker in the Cloudflare dashboard)

If you want the Worker to build its OAuth redirect URI from a fixed hostname instead of whatever
the incoming request's origin is (useful once the custom domain is live and you want to stop using
the `workers.dev` URL entirely), set the `APP_BASE_URL` var in `wrangler.jsonc` and redeploy.

## 11. Connect QuickBooks

Sign in to the app, click **Reconnect QB** (or visit `/api/qbo/connect`), and authorize against
your QuickBooks company. The encrypted token bundle lands in D1; nothing is ever written back to
the browser.

## 12. Install the PWA

Visit the deployed URL in Chrome/Edge/Safari and either:

- Click the **Install App** button that appears in the header once the browser fires its install
  prompt, or
- Use the browser's native "Install app" / "Add to Home Screen" menu option.

## 13. Removing the old Render and Supabase dependencies

Follow this order — don't skip steps or do them out of order, since each one depends on the
previous step being verified first:

1. Deploy this Worker (step 9) and confirm `/api/health` returns `200`.
2. Apply remote D1 migrations (step 3) and set all production secrets (step 8).
3. Update the Intuit redirect URI (step 10).
4. Have the Mi Casa administrator sign in and reconnect QuickBooks (step 11).
5. Confirm QuickBooks API requests work (e.g. trigger **Overdue Invoices** in the assistant) and
   that a token refresh succeeds (wait until `accessTokenExpiresAt` from `/api/qbo/status` is
   within 5 minutes, then make another request and confirm it still works).
6. Update the repository's GitHub Actions configuration: add a repo **variable** `WORKER_URL`
   (e.g. `https://qb-assistant.micasacarehomes.com`) and a repo **secret** `CRON_SECRET` matching
   the Worker secret from step 8. Manually run each workflow once via **Actions → Run workflow**
   to confirm they reach the new Worker.
7. Only after all of the above is verified working: delete the old Supabase tables
   (`qb_tokens`, `allowed_emails`) and the Supabase project itself, and decommission the Render
   service (delete the service and its environment variables in the Render dashboard).
8. Locally, once you're confident you no longer need it for reference, delete the old `.env` file
   (it is already gitignored and was never committed, but it still holds live Render-era
   credentials on disk).

## Rollback

If something goes wrong after deploying:

- **Worker/code issue**: `npx wrangler deployments list` then `npx wrangler rollback [deployment-id]`
  to restore the previous Worker version. Static assets roll back together with the Worker version.
- **Bad migration**: D1 migrations are additive SQL files; to undo one, write and apply a new
  migration that reverses the change (e.g. `DROP TABLE`/`ALTER TABLE`) rather than editing an
  already-applied migration file.
- **QuickBooks connection broken**: visit `/api/qbo/disconnect` (or use the admin UI) to clear the
  stored connection, then reconnect via `/api/qbo/connect`. This never affects staff accounts or
  chat history.
- **Do not** delete the Render service or Supabase project until the checklist in step 13 above is
  fully confirmed — keep them as a fallback until then.

## Development scripts

```bash
npm run dev            # wrangler dev (local Worker + static assets)
npm run test            # vitest — unit + integration tests, Intuit mocked, no real credentials needed
npm run typecheck       # tsc --noEmit
npm run lint            # eslint src test
npm run build           # alias for typecheck (Wrangler bundles at deploy time)
npm run deploy          # wrangler deploy
npm run db:migrate:local
npm run db:migrate:remote
```

### Testing notes

Tests run under plain Node + Vitest (see `vitest.config.ts`) rather than Miniflare/
`@cloudflare/vitest-pool-workers`. Everything the Worker code touches — Web Crypto, `fetch`, and
the D1 query interface — is a standard API available in Node, so `test/helpers/fakeD1.ts` backs
`D1Database` with a real SQLite database via Node's built-in `node:sqlite`, and Intuit/Gmail/Groq
calls are mocked via `vi.stubGlobal('fetch', ...)`. No real QuickBooks credentials are ever
required to run the suite.

## Environment variables reference

| Name | Where | Purpose |
|---|---|---|
| `INTUIT_CLIENT_ID` | secret | Intuit app client ID |
| `INTUIT_CLIENT_SECRET` | secret | Intuit app client secret — never sent to the browser |
| `TOKEN_ENCRYPTION_KEY` | secret | base64, must decode to exactly 32 bytes — AES-256-GCM key for token-at-rest encryption |
| `SESSION_SECRET` | secret | reserved for future session-signing use; session tokens are currently opaque random values hashed in D1 |
| `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` / `GMAIL_REFRESH_TOKEN` | secret | sending report emails via the Gmail API |
| `GROQ_API_KEY` | secret | conversational fallback in `/api/chat` |
| `CRON_SECRET` | secret | shared secret GitHub Actions sends to authenticate scheduled `/api/cron/*` triggers |
| `INTUIT_ENVIRONMENT` | `wrangler.jsonc` var | `"sandbox"` or `"production"` |
| `APP_BASE_URL` | `wrangler.jsonc` var | optional fixed hostname for OAuth redirect URIs; leave blank to derive from the request origin |

## Administrator setup notes

There is no public sign-up route. Staff accounts are created either by an existing admin from
`/admin.html`, by running `scripts/create-admin.mjs` directly against D1 (see step 5), or
interactively with `npm run create-admin:interactive`, which prompts for the email/password instead
of taking them as CLI arguments. Passwords are hashed with PBKDF2-HMAC-SHA256 (100,000 iterations —
the Workers runtime's hard cap for PBKDF2; `crypto.subtle` throws above it — with a random 16-byte
salt per user) via Web Crypto — never stored or logged in plaintext.
