# Migration Plan: Render + Supabase → Cloudflare Workers + D1

## 1. Current architecture (before migration)

A single Node.js/Express process (`index.js`, ~1600 lines) deployed on **Render**, serving a
single static HTML SPA (`assistant.html`) at `/assistant`. There is no build step, no
TypeScript, and no test suite.

```
Browser (assistant.html)
   │  fetch('/api/chat', '/qb/*')
   ▼
Express app on Render (index.js)
   ├── express-session + passport-google-oauth20  → Google sign-in
   ├── Supabase (Postgres via REST)                → allowed_emails table (auth allowlist)
   │                                                → qb_tokens table (QuickBooks OAuth tokens, PLAINTEXT)
   ├── intuit-oauth SDK                             → QuickBooks OAuth + API calls
   ├── googleapis (Gmail)                           → transactional email (overdue/monthly/KanCare reminders)
   ├── groq-sdk                                     → chat completions for the assistant
   └── GitHub Actions (cron)                        → hits Render URLs on a schedule, because
                                                        Render's free tier spins down and there is
                                                        no in-process cron
```

Key facts:
- **Render dependency**: `RENDER_EXTERNAL_URL` is used to build the Google/Gmail OAuth callback
  URLs (`index.js:37-39`, `index.js:73-75`), and the server log prints it as the base URL
  (`index.js:1628`). GitHub Actions workflows hard-code `https://micasaqb.onrender.com` and retry
  in a loop specifically to "wake up" the free-tier instance.
- **Supabase dependency**: `@supabase/supabase-js` client (`index.js:13-16`) is used for:
  - `qb_tokens` table — QuickBooks `access_token`/`refresh_token` stored **in plaintext columns**,
    loaded at startup and read/written on every request that touches QuickBooks
    (`loadTokensFromSupabase`, `saveTokensToSupabase`, `ensureQBToken`).
  - `allowed_emails` table — the authorization allowlist checked by the Google OAuth verify
    callback (`index.js:49-54`) and by `/admin` routes.
- **Authentication**: Google OAuth via Passport (`passport-google-oauth20`), gated by the
  Supabase `allowed_emails` table. Sessions are server-side (`express-session`, in-memory store —
  lost on every Render restart) using a cookie signed with `SESSION_SECRET`.
- **QuickBooks OAuth**: `intuit-oauth` SDK holds a single shared, mutable `oauthClient` and a
  module-level `qbRealmId` variable — i.e. server-side global state, which does not exist in the
  Workers request-scoped model.
- **Frontend**: plain HTML/CSS/vanilla JS, no framework, no bundler. This carries over almost
  unchanged.

## 2. Current QuickBooks OAuth flow

1. `GET /connect` — builds an Intuit authorize URL with a **static, non-random `state` value**
   (`'mi-casa-qb'`, `index.js:735`) and redirects. No CSRF protection: the state is never
   validated on callback.
2. `GET /callback` — exchanges the code for tokens via `oauthClient.createToken(req.url)`, then
   calls `saveTokensToSupabase(...)` **without awaiting it** (`index.js:749`, `.catch()` only) —
   the HTTP response can be sent to the user before the token is actually persisted.
3. Every request under `/qb/*` (and the report-email endpoints) runs `ensureQBTokenMiddleware` →
   `ensureQBToken()`, which:
   - Reads the current row from `qb_tokens`.
   - Refreshes if the access token has less than 5 minutes left.
   - Calls `oauthClient.refresh()` (single-flight only via a module-level promise,
     `refreshInFlight`, which only helps within one Node process).
   - Saves whatever comes back, unconditionally, with a plain `upsert` — no version check.
4. `/keep-alive`, hit weekly by GitHub Actions, exists purely to refresh the token so Intuit's
   ~100-day refresh-token inactivity expiry never triggers, working around Render's cold starts.

## 3. Why token refreshes can fail

1. **No optimistic concurrency** — if two requests both see an expiring token and both refresh,
   Intuit rotates the refresh token on every refresh call. Whichever `upsert` lands second
   "wins", but if the first refresh's *new* refresh token is the one Intuit now expects and the
   second request's refresh happened against the same (now-stale) refresh token, one of the two
   refresh calls will succeed with Intuit while invalidating the other's expectations — and the
   plain last-write-wins `upsert` can overwrite a newer, valid refresh token with an older one,
   permanently breaking the connection (Intuit rejects the stale refresh token on the next
   attempt with `invalid_grant`).
2. **Fire-and-forget save on callback** — a crash or slow Supabase write between token exchange
   and save can lose the very first token pair with no retry.
3. **Static OAuth state** — not a refresh-failure cause per se, but a CSRF hole: any third party
   can start an OAuth flow that completes against the app's callback.
4. **Process-local single-flight** — `refreshInFlight` only deduplicates concurrent refreshes
   within one Node process. Render can and does run cold starts / restarts, so this protection
   resets constantly and provides weaker protection than it looks like.
5. **Render free-tier spin-down** — cold starts wipe the in-memory `qbRealmId`/`oauthClient`
   state; the GitHub Actions "wake up Render" retry loops exist only to paper over this.
6. **No `invalid_grant` recovery** — if Intuit rejects a refresh token as already-rotated, the
   code does not reload the D1/Supabase record to check whether a concurrent request already
   has a newer one; it just fails.

## 4. Files that need to change

| File | Disposition |
|---|---|
| `index.js` | Removed. Logic split into `src/` (Cloudflare Worker, TypeScript). |
| `assistant.html` | Moved to `public/index.html`, adapted for same-origin `/api/*` calls, PWA install hooks, no framework change needed. |
| `package.json` | Rewritten: drop `express`, `express-session`, `passport*`, `@supabase/supabase-js`, `intuit-oauth`, `googleapis`, `node-cron`; add `hono`, `wrangler`, `vitest`, `@cloudflare/vitest-pool-workers`, `typescript`. |
| `.env` | Replaced by `.dev.vars` (local-only, gitignored) + Wrangler secrets in production. Never committed. |
| `.gitignore` | Extended to cover `.dev.vars`, `.wrangler/`, D1 sqlite files, `*.db`, build output. |
| `.github/workflows/*.yml` | URLs updated from `micasaqb.onrender.com` to the Worker's hostname; "wake up Render" retry framing removed (Workers don't sleep); `weekly-token-keep-alive.yml` deleted per explicit instruction not to refresh-on-cron (daily-check already exercises the token daily, which has the same keep-alive effect). |
| *(new)* `wrangler.jsonc` | Worker + Static Assets + D1 binding configuration. |
| *(new)* `migrations/0001_init.sql` | D1 schema: `qbo_connections`, `users`, `sessions`, `oauth_state`, `rate_limits`. |
| *(new)* `src/**` | Worker source: routing, QuickBooks OAuth, token encryption/repository/refresh manager, staff auth, Gmail send, Groq chat proxy, security headers. |
| *(new)* `test/**` | Vitest + Workers pool tests (Intuit mocked). |
| *(new)* `public/manifest.webmanifest`, `public/sw.js`, `public/icons/*` | PWA. |

## 5. Data that needs to move

- **QuickBooks tokens** (`qb_tokens` in Supabase) → **not copied automatically**. Per the
  required safer migration process, the administrator reconnects QuickBooks once against the new
  Worker; the new encrypted D1 record is created fresh from that reconnection. The old Supabase
  plaintext row is left alone until the new system is verified working, then deleted.
- **Allowed emails / staff accounts** (`allowed_emails` in Supabase) → becomes the `users` table
  in D1 (email + password hash instead of just an allowlist, since Google sign-in is replaced by
  local email/password auth — see below). The administrator re-creates staff accounts using the
  documented bootstrap command; existing emails are not auto-migrated with passwords because none
  exist to migrate (Google OAuth never had a Mi Casa-side password).
- **Gmail refresh token** (env var, not Supabase) → becomes the `GMAIL_REFRESH_TOKEN` Worker
  secret, unchanged in value, just relocated from Render's env to `wrangler secret`.

## 6. Authentication system change (explicit, required)

The current login system depends on Supabase (the `allowed_emails` allowlist gates who is allowed
to authenticate), and its session middleware (Passport + `express-session`) is Node-specific and
does not run on Workers' fetch-based model. Per the migration instructions' explicit fallback for
this situation, this migration **replaces Google sign-in with local email/password accounts**:

- `users` table in D1: `id`, `email`, `password_hash`, `password_salt`, `iterations`, `is_admin`,
  `created_at`, `updated_at`.
- Passwords hashed with **PBKDF2-HMAC-SHA256**, 100,000 iterations (the Workers runtime's hard cap —
  `crypto.subtle` throws `NotSupportedError` above it), random 16-byte salt per user, via Web Crypto
  (`crypto.subtle.deriveBits`).
- Sessions: opaque random session token in an `HttpOnly`, `Secure`, `SameSite=Lax` cookie; only
  a SHA-256 hash of the token is stored server-side in a `sessions` table (mirrors the QuickBooks
  token-hashing posture — the raw session token is never persisted). Nothing is put in
  `localStorage`.
- Every `/api/*` route (QuickBooks and otherwise) requires a valid session.
- Initial administrator setup is a documented one-time Wrangler D1 command (see README) — no
  public "sign up" endpoint exists.

This is a user-facing change (the login screen no longer has a "Sign in with Google" button) but
is required by the Supabase-removal constraint and was confirmed with the project owner before
implementation.

## 7. Features that must remain unchanged

- The full chat-based assistant UI in `assistant.html`/`index.html`: Mi Casa / Access Mental
  Health theme toggle, quick-action buttons, invoice preview → confirm → create flow, payment
  lookup → confirm → record flow, new-resident duplicate-check → confirm → create flow, overdue
  summary card, Groq-backed conversational fallback.
- All `/qb/*` (moving to `/api/qbo/*`) business logic: `preview-invoices`, `create-invoices`,
  `preview-payment`, `record-payment`, `overdue-summary`, `preview-resident`, `create-resident`.
- Scheduled email reports: daily overdue check, 30-day overdue alert, monthly invoice notice,
  KanCare billing reminder — triggered the same way (GitHub Actions cron hitting an HTTP
  endpoint), just pointed at the new Worker URL instead of Render.
- `/terms` and `/privacy` static pages.
- Admin management of the staff allowlist (now: staff **accounts** rather than just emails).

## 8. Target architecture (after migration)

```
Browser (installable PWA: public/index.html + manifest + service worker)
   │  same-origin fetch, HttpOnly session cookie
   ▼
Cloudflare Worker (src/index.ts, Hono router)
   ├── /              → Static Assets (public/*)
   ├── /api/auth/*    → login, logout, session check (D1 `users`, `sessions`)
   ├── /api/qbo/connect|callback|status|disconnect  → QuickBooks OAuth (state in HttpOnly cookie)
   ├── /api/qbo/*     → preview/create invoices, payments, residents, overdue summary
   ├── /api/chat      → Groq proxy
   ├── /api/admin/*   → manage staff users
   └── /api/cron/*    → daily/30-day/monthly/kancare report triggers (GitHub Actions calls these)
        │
        ▼
   Cloudflare D1 (qbo_connections, users, sessions, oauth_state, rate_limits)
```

All QuickBooks access/refresh tokens, the Intuit client secret, and `TOKEN_ENCRYPTION_KEY` never
leave the Worker. The browser only ever sees `/api/qbo/status` → `{ connected: true/false, ... }`.
