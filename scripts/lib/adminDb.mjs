// Shared helpers for scripts/create-admin.mjs and scripts/create-admin-interactive.mjs.
// Keeping this logic in one place ensures both entry points hash passwords the
// same way the app does (src/lib/password.ts) and target the same D1 database
// wrangler.jsonc actually binds to the Worker as `env.DB`.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Must match src/lib/password.ts: 100,000 is the Workers runtime's hard cap
// for PBKDF2 (crypto.subtle throws above it), not a security preference.
export const PBKDF2_ITERATIONS = 100_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const COMMON_WEAK_PASSWORDS = new Set([
  'password',
  'password123',
  'passw0rd',
  'letmein',
  'qwertyuiop',
  'admin1234',
  'changeme',
  '12345678901',
  '123456789012'
]);

/**
 * Reads the D1 database name wrangler.jsonc binds as `env.DB` (what the
 * deployed Worker actually queries), so this script can never drift out of
 * sync with the real config the way its old hardcoded default did.
 */
export function getConfiguredDbName() {
  const configPath = path.join(REPO_ROOT, 'wrangler.jsonc');
  const raw = readFileSync(configPath, 'utf8');
  // Strip // line comments and /* */ block comments so JSONC parses as JSON.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const config = JSON.parse(stripped);
  const dbEntry = (config.d1_databases ?? []).find(entry => entry.binding === 'DB');
  if (!dbEntry?.database_name) {
    throw new Error("Couldn't find a d1_databases entry with binding \"DB\" in wrangler.jsonc.");
  }
  return dbEntry.database_name;
}

export function isValidEmail(email) {
  // Deliberately conservative (no unicode/quoted-local-part support) — good
  // enough to catch typos in an admin's own email without rejecting anything
  // realistic.
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(
    email
  );
}

/**
 * Returns a failure reason string, or null if the password is acceptable.
 * Mirrors the app's 12-character minimum (src/routes/admin.ts) plus a few
 * cheap checks for obviously weak passwords.
 */
export function passwordWeaknessReason(password, email) {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (password.length > 256) return 'Password is unreasonably long.';
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) return 'Password is too common/guessable.';
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character.';
  if (/^\d+$/.test(password)) return 'Password cannot be digits only.';
  const localPart = email?.split('@')[0]?.toLowerCase();
  if (localPart && password.toLowerCase().includes(localPart)) {
    return 'Password cannot contain your email address.';
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter(re => re.test(password)).length;
  if (classes < 2) return 'Password must mix at least two of: lowercase, uppercase, digits, symbols.';
  return null;
}

/** Generates a random, high-entropy temporary password for one-time use. */
export function generateTemporaryPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const bytes = randomBytes(24);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

/** PBKDF2-HMAC-SHA256 — must match src/lib/password.ts exactly. */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits'
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { hash: toBase64(new Uint8Array(bits)), salt: toBase64(salt) };
}

function sqlEscape(value) {
  return value.replace(/'/g, "''");
}

/**
 * Runs a SQL statement via `wrangler d1 execute --file`, never `--command` —
 * putting the password hash/salt in argv would leak them into the process
 * list (`ps`) and shell history. The temp file is written with owner-only
 * permissions and removed immediately after, whether or not the command
 * succeeds. Returns the parsed --json output.
 *
 * wrangler prints human-readable progress lines (e.g. "Uploading...") to
 * stdout ahead of the JSON when using --file against --remote, so the JSON
 * payload is extracted from the last top-level `[` rather than assuming
 * stdout is pure JSON.
 */
function extractJson(stdout) {
  const match = stdout.match(/^\[\s*$/m);
  const jsonText = match ? stdout.slice(match.index) : stdout;
  return JSON.parse(jsonText);
}

function runWrangler(dbName, remote, extraArgs) {
  const result = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', dbName, remote ? '--remote' : '--local', ...extraArgs, '--json'],
    { encoding: 'utf8' }
  );
  if (result.error) {
    throw new Error(`Failed to launch wrangler: ${result.error.message}`);
  }
  if (result.status !== 0) {
    // wrangler's own stderr for D1 errors describes the failure (e.g.
    // "no such table") and does not echo bound literals back — safe to surface.
    throw new Error((result.stderr || result.stdout || 'wrangler exited with a non-zero status').trim());
  }
  try {
    return extractJson(result.stdout);
  } catch {
    throw new Error('Could not parse wrangler --json output.');
  }
}

/**
 * Runs a read-only, non-sensitive SQL statement (only ever fed an already-
 * normalized email, never a password/hash) via `wrangler d1 execute
 * --command`, which returns real row results on both --local and --remote.
 */
export function runD1Query(dbName, remote, sql) {
  return runWrangler(dbName, remote, ['--command', sql]);
}

/**
 * Runs a mutating SQL statement that embeds the password hash/salt via
 * `wrangler d1 execute --file` instead of `--command`, so the hash/salt never
 * appear in this process's argv (visible to `ps`) or shell history. The temp
 * file is written with owner-only permissions and removed immediately after,
 * whether or not the command succeeds. Only meta.changes/success should be
 * relied on — `--file` against --remote returns aggregate stats, not row data.
 */
export function runD1Write(dbName, remote, sql) {
  const dir = mkdtempSync(path.join(tmpdir(), 'qb-admin-'));
  const file = path.join(dir, 'query.sql');
  try {
    writeFileSync(file, sql, { mode: 0o600 });
    return runWrangler(dbName, remote, ['--file', file]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function buildUpsertSql({ email, hash, salt, isAdmin }) {
  const id = crypto.randomUUID();
  const now = Date.now();
  const normalizedEmail = sqlEscape(email.toLowerCase().trim());
  const role = isAdmin ? 'admin' : 'staff';
  return `INSERT INTO users (id, email, password_hash, password_salt, iterations, role, disabled, force_password_change, created_at, updated_at)
VALUES ('${id}', '${normalizedEmail}', '${hash}', '${salt}', ${PBKDF2_ITERATIONS}, '${role}', 0, 0, ${now}, ${now})
ON CONFLICT(email) DO UPDATE SET
  password_hash = excluded.password_hash,
  password_salt = excluded.password_salt,
  iterations = excluded.iterations,
  role = excluded.role,
  disabled = 0,
  force_password_change = 0,
  updated_at = excluded.updated_at;`;
}

export function buildVerifySql(email) {
  const normalizedEmail = sqlEscape(email.toLowerCase().trim());
  return `SELECT email, role, disabled, force_password_change, created_at, updated_at, (length(password_hash) > 0) AS has_password_hash
FROM users WHERE email = '${normalizedEmail}';`;
}

/** True if the pre-upsert SELECT found an existing row for this email. */
export function buildExistsSql(email) {
  const normalizedEmail = sqlEscape(email.toLowerCase().trim());
  return `SELECT 1 AS found FROM users WHERE email = '${normalizedEmail}';`;
}
