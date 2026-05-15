/** Known SAP storage locations used in warehouse comparisons */
const KNOWN_SL = new Set(['1001', '1002', '1003', '1004', '1005', '1007']);

/**
 * Normalize SAP storage location text from Excel/DB so quantities bucket into known SL codes.
 * Handles floats (1004.0), leading zeros, commas, and stray text containing a known SL code.
 */
function normalizeSapStorageLoc(raw) {
  const commaFree = String(raw ?? '')
    .replace(/,/g, '')
    .trim()
    .replace(/\s+/g, '');
  if (!commaFree) return '';
  const embedded = commaFree.match(/\b(1001|1002|1003|1004|1005|1007)\b/);
  if (embedded) return embedded[1];
  const asNum = Number(commaFree);
  if (Number.isFinite(asNum)) {
    const rounded = Math.round(asNum);
    if (Math.abs(asNum - rounded) < 1e-6) {
      const code = String(rounded);
      if (KNOWN_SL.has(code)) return code;
    }
  }
  const stripped = commaFree.replace(/^0+/, '') || commaFree;
  const m2 = stripped.match(/\b(1001|1002|1003|1004|1005|1007)\b/);
  if (m2) return m2[1];
  return stripped.replace(/^0+/, '') || stripped;
}

module.exports = { normalizeSapStorageLoc, KNOWN_SL };
