#!/usr/bin/env node
// Creates or updates a Mi Casa staff/administrator account directly in D1.
// Uses the same PBKDF2-HMAC-SHA256 scheme (100,000 iterations — the Workers
// runtime's hard cap) as
// src/lib/password.ts, so accounts created here log in identically to ones
// created via /api/admin/users.
//
// Usage:
//   node scripts/create-admin.mjs <email> <password> [--admin] [--remote] [--db <name>]
//   node scripts/create-admin.mjs <email> --generate [--admin] [--remote] [--db <name>]
//
// By default this runs against the LOCAL D1 database (via wrangler --local).
// Pass --remote to target the production database instead. --db overrides
// the database name; otherwise it's read from wrangler.jsonc's binding "DB"
// entry, which is what the deployed Worker actually queries.
//
// If the email already exists, its password and admin status are UPDATED
// in place (its id and created_at are preserved) rather than failing.
//
// Never prints the password or the derived hash/salt.

import {
  buildExistsSql,
  buildUpsertSql,
  buildVerifySql,
  generateTemporaryPassword,
  getConfiguredDbName,
  hashPassword,
  isValidEmail,
  passwordWeaknessReason,
  runD1Query,
  runD1Write
} from './lib/adminDb.mjs';

function usageAndExit(message) {
  if (message) console.error(`Error: ${message}`);
  console.error('Usage: node scripts/create-admin.mjs <email> <password> [--admin] [--remote] [--db <name>]');
  console.error('   or: node scripts/create-admin.mjs <email> --generate [--admin] [--remote] [--db <name>]');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  const isAdmin = args.includes('--admin');
  const remote = args.includes('--remote');
  const generate = args.includes('--generate');
  const dbFlagIndex = args.indexOf('--db');
  const dbNameOverride = dbFlagIndex !== -1 ? args[dbFlagIndex + 1] : undefined;

  const positional = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--db');
  const [email, passwordArg] = positional;

  if (!email) usageAndExit('An email address is required.');
  if (!isValidEmail(email)) usageAndExit(`"${email}" doesn't look like a valid email address.`);
  if (!generate && !passwordArg) usageAndExit('A password is required (or pass --generate to create one).');
  if (generate && passwordArg) usageAndExit('Pass either a password or --generate, not both.');

  const password = generate ? generateTemporaryPassword() : passwordArg;
  if (!generate) {
    const weakness = passwordWeaknessReason(password, email);
    if (weakness) usageAndExit(weakness);
  }

  let dbName;
  try {
    dbName = dbNameOverride ?? getConfiguredDbName();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  const normalizedEmail = email.toLowerCase().trim();
  const target = remote ? 'REMOTE (production)' : 'local';
  console.log(`Target database: ${dbName} [${target}]`);
  console.log(`Checking for an existing account for ${normalizedEmail}...`);

  let existed;
  try {
    const existsResult = runD1Query(dbName, remote, buildExistsSql(normalizedEmail));
    existed = (existsResult[0]?.results?.length ?? 0) > 0;
  } catch (err) {
    console.error(`Failure: could not query the ${target} database.`);
    console.error(err.message);
    process.exit(1);
  }

  console.log(`${existed ? 'Updating existing' : 'Creating new'} ${isAdmin ? 'admin' : 'staff'} account...`);

  const { hash, salt } = await hashPassword(password);
  try {
    runD1Write(dbName, remote, buildUpsertSql({ email: normalizedEmail, hash, salt, isAdmin }));
  } catch (err) {
    console.error(`Failure: could not write the account to the ${target} database.`);
    console.error(err.message);
    process.exit(1);
  }

  let verified;
  try {
    const verifyResult = runD1Query(dbName, remote, buildVerifySql(normalizedEmail));
    verified = verifyResult[0]?.results?.[0];
  } catch (err) {
    console.error('Failure: account may have been written, but verification failed.');
    console.error(err.message);
    process.exit(1);
  }

  if (!verified || !verified.has_password_hash) {
    console.error('Failure: verification did not find a stored password hash for this account.');
    process.exit(1);
  }

  console.log('');
  console.log(`Success: ${existed ? 'updated' : 'created'} account for ${verified.email}`);
  console.log(`  Role:       ${verified.role}${verified.disabled ? ' (disabled)' : ''}`);
  console.log(`  Created:    ${new Date(verified.created_at).toISOString()}`);
  console.log(`  Updated:    ${new Date(verified.updated_at).toISOString()}`);
  console.log(`  Has hash:   ${verified.has_password_hash ? 'yes' : 'no'}`);

  if (generate) {
    console.log('');
    console.log('One-time temporary password (shown only once — store it securely now):');
    console.log(`  ${password}`);
    console.log('Change this password after logging in.');
  }
}

main().catch(err => {
  console.error('Failure: unexpected error.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
