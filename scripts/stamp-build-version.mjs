#!/usr/bin/env node
// Stamps a build version into public/sw.js so its bytes change on every
// deploy. This is what makes the browser's service-worker update check
// (registration.update()) actually detect a new worker — browsers compare
// the fetched sw.js byte-for-byte against the currently registered one, so
// if this file never changed, `updatefound` would never fire even though
// app.js/styles.css/index.html did change.
//
// Usage:
//   node scripts/stamp-build-version.mjs <version>
//
// Run this against a CI checkout right before `wrangler deploy` — it mutates
// public/sw.js in place. Never commit the stamped result back to git; each
// deploy re-stamps a fresh ephemeral checkout.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const swPath = path.join(__dirname, '../public/sw.js');

const version = process.argv[2];
if (!version || !/^[A-Za-z0-9._-]+$/.test(version)) {
  console.error('Usage: node scripts/stamp-build-version.mjs <version>');
  console.error('  <version> must be a short identifier (git SHA, timestamp) — letters, digits, "." "_" "-" only.');
  process.exit(1);
}

const source = readFileSync(swPath, 'utf-8');
const marker = /const BUILD_VERSION = '[^']*';/;
if (!marker.test(source)) {
  console.error(`Could not find "const BUILD_VERSION = '...';" in ${swPath}`);
  process.exit(1);
}

writeFileSync(swPath, source.replace(marker, `const BUILD_VERSION = '${version}';`));
console.log(`Stamped BUILD_VERSION=${version} into public/sw.js`);
