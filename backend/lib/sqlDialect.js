/**
 * SQLite → PostgreSQL SQL tweaks for the shared warehouse DB adapter.
 */

function convertQuestionMarks(sql, params = []) {
  const arr = Array.isArray(params) ? params : [];
  let i = 0;
  const text = String(sql).replace(/\?/g, () => {
    i += 1;
    return `$${i}`;
  });
  if (i !== arr.length) {
    const err = new Error(`Placeholder count mismatch: expected ${i} params, got ${arr.length}`);
    err.code = 'SQL_PARAM_MISMATCH';
    throw err;
  }
  return { text, values: arr };
}

function replaceFunctionCalls(sql, name, suffix) {
  let out = String(sql);
  const re = new RegExp(`\\b${name}\\s*\\(\\s*`, 'gi');
  let m;
  const replacements = [];
  while ((m = re.exec(out)) !== null) {
    const start = m.index;
    let depth = 1;
    let j = start + m[0].length;
    while (j < out.length && depth > 0) {
      const ch = out[j];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      j += 1;
    }
    if (depth !== 0) continue;
    const innerEnd = j - 1;
    const inner = out.slice(start + m[0].length, innerEnd);
    replacements.push({ start, end: j, inner });
  }
  for (let k = replacements.length - 1; k >= 0; k -= 1) {
    const { start, end, inner } = replacements[k];
    out = `${out.slice(0, start)}(${inner})::${suffix}${out.slice(end)}`;
  }
  return out;
}

/** datetime(expr) → (expr)::timestamptz (SQLite datetime() ordering helper) */
function replaceDatetimeCalls(sql) {
  return replaceFunctionCalls(sql, 'datetime', 'timestamptz');
}

/** date(expr) → safe Postgres date cast (empty string → NULL, avoids ""::date errors) */
function replaceDateCalls(sql) {
  let out = String(sql);
  const re = /\bdate\s*\(\s*/gi;
  const replacements = [];
  let m;
  while ((m = re.exec(out)) !== null) {
    const start = m.index;
    let depth = 1;
    let j = start + m[0].length;
    while (j < out.length && depth > 0) {
      const ch = out[j];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      j += 1;
    }
    if (depth !== 0) continue;
    const innerEnd = j - 1;
    const inner = out.slice(start + m[0].length, innerEnd);
    replacements.push({ start, end: j, inner });
  }
  for (let k = replacements.length - 1; k >= 0; k -= 1) {
    const { start, end, inner } = replacements[k];
    const innerTrim = inner.trim();
    // date(?) must keep a single bound param — the column CASE wrapper duplicates `?` and breaks counts.
    const safe =
      innerTrim === '?'
        ? `(NULLIF(BTRIM(?::text), '')::date)`
        : `(CASE WHEN NULLIF(BTRIM(COALESCE((${inner})::text, '')), '') IS NULL THEN NULL ELSE NULLIF(BTRIM((${inner})::text), '')::date END)`;
    out = `${out.slice(0, start)}${safe}${out.slice(end)}`;
  }
  return out;
}

function translateSqliteDdl(sql) {
  return String(sql)
    .replace(/\bCOLLATE\s+NOCASE\b/gi, '')
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, 'SERIAL PRIMARY KEY')
    .replace(/\bDATETIME\b/gi, 'TIMESTAMP')
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION');
}

function translateInsertOrIgnore(sql) {
  const s = String(sql).replace(/INSERT\s+OR\s+IGNORE/gi, 'INSERT');
  return `${s.trim()} ON CONFLICT DO NOTHING`;
}

/** dn_date is TEXT; created_at/delivered_at are timestamps — COALESCE must not mix types on PG. */
function replaceMixedDnDateCoalesce(sql) {
  let s = String(sql);
  s = s.replace(
    /\bCOALESCE\s*\(\s*dn\.dn_date\s*,\s*dn\.created_at\s*\)/gi,
    "COALESCE((NULLIF(BTRIM(COALESCE(dn.dn_date::text, '')), ''))::date, (dn.created_at)::date)"
  );
  s = s.replace(
    /\bCOALESCE\s*\(\s*dn\.delivered_at\s*,\s*dn\.dn_date\s*,\s*dn\.created_at\s*\)/gi,
    "COALESCE((dn.delivered_at)::date, (NULLIF(BTRIM(COALESCE(dn.dn_date::text, '')), ''))::date, (dn.created_at)::date)"
  );
  s = s.replace(
    /\bCOALESCE\s*\(\s*delivered_at\s*,\s*dn_date\s*,\s*created_at\s*\)/gi,
    "COALESCE((delivered_at)::date, (NULLIF(BTRIM(COALESCE(dn_date::text, '')), ''))::date, (created_at)::date)"
  );
  return s;
}

function translateSqlForPostgres(sql, params) {
  let s = String(sql).trim();
  if (/^PRAGMA\s+/i.test(s)) {
    return { text: 'SELECT 1 AS pragma_noop', values: [] };
  }
  if (/^BEGIN\s+IMMEDIATE/i.test(s)) {
    s = s.replace(/^BEGIN\s+IMMEDIATE/i, 'BEGIN');
  }
  s = s.replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
  s = replaceMixedDnDateCoalesce(s);
  s = replaceDatetimeCalls(s);
  s = replaceDateCalls(s);
  s = translateSqliteDdl(s);
  if (/INSERT\s+OR\s+IGNORE/gi.test(s)) {
    s = translateInsertOrIgnore(s);
  }
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, 'CURRENT_TIMESTAMP');
  return convertQuestionMarks(s, params);
}

module.exports = {
  convertQuestionMarks,
  translateSqlForPostgres,
  replaceDatetimeCalls,
  replaceDateCalls,
};
