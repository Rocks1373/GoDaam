/**
 * Excel stores calendar dates as serial numbers (days since 1899-12-30, with fractional day for time).
 * sheet_to_json returns numbers unless cellDates: true (then Date objects).
 */

function excelDateToJSDate(serial) {
  if (serial === null || serial === undefined || serial === '') return null;
  const n = Number(serial);
  if (!Number.isFinite(n)) return null;
  // Unix ms from Excel serial (25569 = days between 1899-12-30 and 1970-01-01)
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Persist / API canonical format */
function formatYYYYMMDD(d) {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normKey(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/** Column headers treated as date fields when cells contain Excel serial numbers */
function isDateColumnKey(key) {
  const k = normKey(key);
  if (!k) return false;
  if (k === 'date') return true;
  if (k.includes('date')) return true;
  if (/_at$/.test(k)) return true;
  return false;
}

/**
 * Normalize a single cell: Excel serial number → YYYY-MM-DD for date columns only.
 * Also normalizes Date instances and common string shapes to YYYY-MM-DD.
 */
function normalizeExcelDateCell(value, key) {
  if (!isDateColumnKey(key)) return value;
  if (value === '' || value === null || value === undefined) return value;

  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = excelDateToJSDate(value);
    return d ? formatYYYYMMDD(d) : String(value);
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatYYYYMMDD(value);
  }

  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  const m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\s*$/);
  if (m) {
    let dd = parseInt(m[1], 10);
    let mm = parseInt(m[2], 10);
    let yy = parseInt(m[3], 10);
    if (yy < 100) yy += yy >= 70 ? 1900 : 2000;
    const dt = new Date(yy, mm - 1, dd);
    if (!Number.isNaN(dt.getTime())) return formatYYYYMMDD(dt);
  }
  return value;
}

/** Return a shallow copy of the row with date columns normalized to YYYY-MM-DD strings */
function normalizeExcelRowDates(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const key of Object.keys(out)) {
    out[key] = normalizeExcelDateCell(out[key], key);
  }
  return out;
}

/** Map an array of sheet rows through normalizeExcelRowDates */
function normalizeExcelRows(rows) {
  if (!Array.isArray(rows)) return rows;
  return rows.map((r) => normalizeExcelRowDates(r));
}

module.exports = {
  excelDateToJSDate,
  formatYYYYMMDD,
  isDateColumnKey,
  normalizeExcelDateCell,
  normalizeExcelRowDates,
  normalizeExcelRows,
};
