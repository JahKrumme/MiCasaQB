# Scheduled Financial Email Jobs — Production Walkthrough

A safe, step-by-step guide for a human to verify all four scheduled
financial email jobs in production, after the Daily Overdue Check's
`invalid_client` fix and the same hardening applied to the other three
jobs. Follow the steps **in order** — each stage is strictly safer than
the next, and none of the first two stages can ever send a real email.

The four jobs, their schedules (all times CST, unchanged by this work),
and their GitHub Actions workflows:

| Job | Schedule | Workflow file | Endpoint |
|---|---|---|---|
| Daily Overdue Check | Daily, 8:00 AM | `daily-check.yml` | `/api/cron/overdue-check` |
| 30-Day Overdue Alert | Mondays, 8:00 AM | `30-day-alert.yml` | `/api/cron/30-day-alert` |
| Monthly Invoice Notice | 20th of the month, 8:00 AM | `monthly-invoices.yml` | `/api/cron/monthly-invoices` |
| KanCare Billing Reminder | 25th of the month, 8:00 AM | `kancare-reminder.yml` | `/api/cron/kancare-reminder` |

All four workflows live in `QuikBooks/.github/workflows/` and are run via
`gh workflow run <file> [-f dryRun=true | -f diagnostic=true]` from the
`QuikBooks/` repo, or from the **Actions** tab on GitHub
(Run workflow → check the box for the input you want).

## Stage 1 — Diagnostic (completely safe, do this first for every job)

Exercises the real QuickBooks query, the real email payload, real
recipient validation, and a real Gmail token refresh — and stops
immediately before the network call that would actually deliver anything.
**Never sends an email under any outcome.** Never writes to the audit log
or changes any Integration Health card.

```
gh workflow run daily-check.yml -f diagnostic=true
gh workflow run 30-day-alert.yml -f diagnostic=true
gh workflow run monthly-invoices.yml -f diagnostic=true
gh workflow run kancare-reminder.yml -f diagnostic=true
```

Check each run's log (Actions tab, or `gh run view <run-id> --log`) for a
line like:

```json
{"ok":true,"job":"30_day_alert","phase":"ready","category":null,"recordCount":7,"hasRecipients":true,"gmailAuthOk":true,"messageBuilt":true}
```

- **`ok:true`, `phase:"ready"`** — everything checks out; a real send would
  succeed right now.
- **`ok:false`** — look at `phase` and `category` together:
  - `phase:"quickbooks_query"`, `category:"no_token"` — QuickBooks isn't
    connected. Reconnect from Finance → Settings in the CRM.
  - `phase:"recipients"`, `category:"recipient_invalid"` — no active users
    with a valid email exist to receive the digest. Check the Users list.
  - `phase:"gmail_auth"`, `category:"invalid_client"` — the
    `GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET` pair is rejected by Google.
    See the "Gmail credential problems" section below.
  - `phase:"gmail_auth"`, `category:"invalid_grant"` — the refresh token
    itself is rejected (revoked/expired). Regenerate it (see below).
  - `phase:"gmail_auth"`, `category:"rate_limited"` or `"transient"` —
    Google's token endpoint is temporarily unhappy. Wait a few minutes and
    re-run diagnostic.

`recordCount` tells you how many real invoices/records this job would
report right now (`null` for KanCare's reminder, which has no underlying
query). If this number looks wrong, that's a QuickBooks data question, not
something this diagnostic can help with further — check the numbers
directly in QuickBooks Online.

## Stage 2 — Dry run (still completely safe)

Slightly lighter-weight than diagnostic (skips building the exact message
body) — mainly useful as a quick "is Gmail still working" check without
the full trace:

```
gh workflow run daily-check.yml -f dryRun=true
gh workflow run 30-day-alert.yml -f dryRun=true
gh workflow run monthly-invoices.yml -f dryRun=true
gh workflow run kancare-reminder.yml -f dryRun=true
```

Look for `"gmailAuthOk":true` in the run's log. Also never sends an email,
never writes to the audit log.

## Stage 3 — A real send (only once Stage 1 shows `ok:true` for that job)

**This actually emails your real recipients.** Only do this deliberately,
one job at a time, when you're ready for that job's real reminder/notice to
go out. Trigger it with no input flags (or via the Actions tab with both
checkboxes left unchecked):

```
gh workflow run daily-check.yml
gh workflow run 30-day-alert.yml
gh workflow run monthly-invoices.yml
gh workflow run kancare-reminder.yml
```

Each real run (success or failure) is now recorded to Companion's audit
log and immediately visible on the CRM's Integration Health page — see
Stage 4.

**Do not run Stage 3 for the same job repeatedly while debugging.** If a
real run fails, go back to Stage 1 (diagnostic) to investigate — it's free
and safe to run as many times as you need.

## Stage 4 — Confirm in the CRM's Integration Health page

Sign in to the CRM as Admin → `/integration-health.html` → look under the
**Finance** section for four cards: **Daily Overdue Check**, **30-Day
Overdue Alert**, **Monthly Invoice Notice**, **KanCare Billing Reminder**.

- **Not configured** — no real (Stage 3) run has ever completed for that
  job yet. This is expected and correct until you run Stage 3 at least
  once.
- **Operational** — the most recent real run succeeded; the card shows the
  real record count.
- **Degraded** — the most recent real run failed; the card shows the safe
  error category (same vocabulary as Stage 1's `category` field).

A failure in one job's card never affects the other three — they're
tracked completely independently.

You can also check the **Gmail sending** card on the same page — this
reflects the **Send Test Email** action specifically (a separate,
independent verification path), not these four jobs. As of this pass, that
card was corrected to honestly read "Configured, unverified" (a previous
stale placeholder falsely showed "Operational" — see
`docs/INTEGRATION_HEALTH.md` in the CRM repo for detail). If you want a
completely isolated Gmail check independent of any of these four jobs,
click **Send Test Email** there.

## Gmail credential problems

Both `invalid_client` and `invalid_grant` come from the same shared Gmail
credential set (`GMAIL_CLIENT_ID`/`GMAIL_CLIENT_SECRET`/
`GMAIL_REFRESH_TOKEN`) used by all four jobs — fixing it once fixes all
four. Re-run Stage 1 for every job afterward before attempting Stage 3.

**`invalid_client`** — Google is rejecting the client_id/client_secret pair
itself, not the refresh token.
1. Google Cloud Console → APIs & Services → Credentials → the OAuth client
   matching `GMAIL_CLIENT_ID`.
2. Confirm it still exists and isn't disabled; confirm the client secret
   shown there matches what's stored in Cloudflare.
3. If it doesn't match (e.g. someone reset it in the Console), copy the
   current one and run `npx wrangler secret put GMAIL_CLIENT_SECRET` from
   this repo.

**`invalid_grant`** — the refresh token itself is rejected (revoked or
expired).
1. Go to `https://developers.google.com/oauthplayground`, gear icon → check
   **"Use your own OAuth credentials"** → enter `GMAIL_CLIENT_ID`/
   `GMAIL_CLIENT_SECRET`.
2. Make sure `https://developers.google.com/oauthplayground` is listed
   under that OAuth client's **Authorized redirect URIs** in Google Cloud
   Console.
3. Sign in as **`micasacarehomes@gmail.com`** specifically (the sending
   address is hardcoded in the email's `From` header) — not a personal
   account.
4. Step 1: select scope `https://www.googleapis.com/auth/gmail.send` only,
   check **"Force prompt to consent screen"**, Authorize.
5. Step 2: Exchange authorization code for tokens → copy the **Refresh
   token** value directly (don't paste it anywhere else).
6. `npx wrangler secret put GMAIL_REFRESH_TOKEN` from this repo, paste the
   value at the prompt (input isn't echoed).
7. If your Google Cloud OAuth consent screen is still in **Testing**
   status, refresh tokens expire after 7 days regardless of use — consider
   moving it to **In production** so this doesn't recur.

## What this walkthrough intentionally does not do

- It does not trigger a real send on your behalf — Stage 3 is something
  only you should decide to run, and only after you've reviewed Stage 1's
  output for that specific job.
- It does not change recipients, email content, invoice-query logic,
  schedules, or reminder thresholds — none of that changed in this pass.
- It does not touch real QuickBooks accounting data — every stage only
  ever reads invoices via existing QuickBooks queries.
