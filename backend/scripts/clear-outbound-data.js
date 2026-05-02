#!/usr/bin/env node
/**
 * CLI: wipe all outbound-related rows from the SQLite warehouse DB.
 * Usage (from repo root or backend/):
 *   node scripts/clear-outbound-data.js
 *   node scripts/clear-outbound-data.js --yes
 *
 * Without --yes, prints counts and exits (dry run).
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { promisify } = require('util');
const db = require('../db');
const { clearOutboundDomain, BROWSE_WHITELIST } = require('../services/outboundDomainClear');

const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

async function counts() {
  const out = {};
  for (const t of BROWSE_WHITELIST) {
    const row = await dbGet(`SELECT COUNT(1) AS c FROM ${t}`);
    out[t] = Number(row?.c) || 0;
  }
  return out;
}

async function main() {
  const yes = process.argv.includes('--yes');
  const before = await counts();
  console.log('Outbound-related row counts (before):');
  console.table(before);
  if (!yes) {
    console.log('\nDry run. Re-run with --yes to delete all outbound domain data.');
    process.exit(0);
  }
  await clearOutboundDomain(dbRun);
  const after = await counts();
  console.log('\nCleared. Row counts (after):');
  console.table(after);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
