/**
 * Reads a VPS-style KEY=value env file and writes godam-mobile/.env with base64-encoded
 * EXPO_PUBLIC_*_B64 keys (decoded at build time in app.config.js).
 *
 * Usage: node scripts/test-mobile/write-encoded-env.mjs <pulled-env-path> <output-.env-path>
 */
import fs from 'fs';
import path from 'path';

const pullPath = process.argv[2];
const outPath = process.argv[3];
if (!pullPath || !outPath) {
  console.error('Usage: node write-encoded-env.mjs <pulled-env> <out-.env>');
  process.exit(1);
}

function parseEnvFile(text) {
  const out = {};
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function pickApiOrigin(env) {
  const candidates = [
    env.MOBILE_APP_EMBEDDED_API_BASE,
    env.PUBLIC_API_ORIGIN,
    env.EXPO_PUBLIC_API_URL,
    env.API_PUBLIC_URL,
  ].filter(Boolean);
  for (const c of candidates) {
    let s = String(c).trim().replace(/\/+$/, '');
    if (!s || s === '*') continue;
    if (/\/api$/i.test(s)) s = s.replace(/\/api$/i, '');
    try {
      const u = new URL(s.includes('://') ? s : `https://${s}`);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {
      continue;
    }
  }
  const cors = String(env.CORS_ORIGIN || '').trim();
  if (cors && cors !== '*') {
    for (const part of cors.split(',')) {
      const s = part.trim().replace(/\/+$/, '');
      if (/^https:\/\//i.test(s)) {
        try {
          return new URL(s).origin;
        } catch {
          continue;
        }
      }
    }
  }
  return 'https://godam.divadivya.cloud';
}

const raw = fs.readFileSync(pullPath, 'utf8');
const env = parseEnvFile(raw);
const origin = pickApiOrigin(env);
const mobileKey = String(env.MOBILE_APP_API_KEY || '').trim();

const apiB64 = Buffer.from(origin, 'utf8').toString('base64');
const lines = [
  '# Auto-generated — do not commit. Decoded in app.config.js at Metro/Gradle bundle time.',
  `EXPO_PUBLIC_API_URL_B64=${apiB64}`,
];
if (mobileKey) {
  lines.push(`EXPO_PUBLIC_MOBILE_API_KEY_B64=${Buffer.from(mobileKey, 'utf8').toString('base64')}`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
console.log(`Wrote ${outPath}`);
console.log(`API origin (plaintext, for your records only): ${origin}`);
console.log(mobileKey ? 'MOBILE_APP_API_KEY: present → encoded in .env' : 'MOBILE_APP_API_KEY: absent');
