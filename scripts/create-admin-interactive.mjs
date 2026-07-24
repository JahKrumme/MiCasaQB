#!/usr/bin/env node
// Interactive counterpart to scripts/create-admin.mjs — prompts for the
// admin email and password instead of taking the password as a CLI argument,
// so it never lands in shell history or `ps` output. Run with:
//
//   npm run create-admin:interactive
//
// Password input is masked when run in a real terminal (TTY); it falls back
// to plain input (with a warning) when stdin isn't a TTY, e.g. piped input.

import { createInterface } from 'node:readline/promises';
import {
  buildExistsSql,
  buildUpsertSql,
  buildVerifySql,
  getConfiguredDbName,
  hashPassword,
  isValidEmail,
  passwordWeaknessReason,
  runD1Query,
  runD1Write
} from './lib/adminDb.mjs';

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl.question(question).then(answer => {
    rl.close();
    return answer;
  });
}

// Control character codes, referenced by charCode rather than embedding raw
// control bytes in this source file.
const CHARCODE_CTRL_C = 3;
const CHARCODE_CTRL_D = 4;
const CHARCODE_BACKSPACE = 8;
const CHARCODE_DEL = 127;
const CHARCODE_LF = 10;
const CHARCODE_CR = 13;

function askHidden(question) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    console.warn('(stdin is not a TTY - password input will be visible)');
    return ask(question);
  }

  return new Promise((resolve, reject) => {
    stdout.write(question);
    let input = '';
    const onData = chunk => {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        const code = ch.charCodeAt(0);
        if (code === CHARCODE_LF || code === CHARCODE_CR) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          resolve(input);
          return;
        }
        if (code === CHARCODE_CTRL_C || code === CHARCODE_CTRL_D) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener('data', onData);
          stdout.write('\n');
          reject(new Error('Cancelled.'));
          return;
        }
        if (code === CHARCODE_BACKSPACE || code === CHARCODE_DEL) {
          input = input.slice(0, -1);
          continue;
        }
        input += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

async function main() {
  const email = (await ask('Admin email: ')).trim();
  if (!isValidEmail(email)) {
    console.error(`Failure: "${email}" doesn't look like a valid email address.`);
    process.exit(1);
  }

  const password = await askHidden('New password (hidden): ');
  const weakness = passwordWeaknessReason(password, email);
  if (weakness) {
    console.error(`Failure: ${weakness}`);
    process.exit(1);
  }

  const confirmation = await askHidden('Confirm password (hidden): ');
  if (password !== confirmation) {
    console.error('Failure: passwords do not match.');
    process.exit(1);
  }

  const remoteAnswer = (await ask('Use the remote (production) D1 database? [y/N]: ')).trim().toLowerCase();
  const remote = remoteAnswer === 'y' || remoteAnswer === 'yes';

  let dbName;
  try {
    dbName = getConfiguredDbName();
  } catch (err) {
    console.error(`Failure: ${err.message}`);
    process.exit(1);
  }

  const normalizedEmail = email.toLowerCase().trim();
  const target = remote ? 'REMOTE (production)' : 'local';
  console.log(`\nTarget database: ${dbName} [${target}]`);

  let existed;
  try {
    const existsResult = runD1Query(dbName, remote, buildExistsSql(normalizedEmail));
    existed = (existsResult[0]?.results?.length ?? 0) > 0;
  } catch (err) {
    console.error(`Failure: could not query the ${target} database.`);
    console.error(err.message);
    process.exit(1);
  }

  console.log(`${existed ? 'Updating existing' : 'Creating new'} admin account...`);

  const { hash, salt } = await hashPassword(password);
  try {
    runD1Write(dbName, remote, buildUpsertSql({ email: normalizedEmail, hash, salt, isAdmin: true }));
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
}

main().catch(err => {
  console.error('Failure: unexpected error.');
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
