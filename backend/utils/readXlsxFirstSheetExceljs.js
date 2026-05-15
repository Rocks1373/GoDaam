/**
 * Read first worksheet as row objects (header row = keys).
 * Uses exceljs instead of xlsx (SheetJS) to avoid known prototype-pollution / ReDoS advisories on user uploads.
 */
const { Readable } = require('stream');
const ExcelJS = require('exceljs');

function cellToScalar(cell) {
  if (!cell || cell.value == null) return '';
  const v = cell.value;
  if (typeof v === 'object' && v !== null) {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v.richText && Array.isArray(v.richText)) {
      return v.richText.map((t) => String(t.text || '')).join('');
    }
    if (v.text != null) return String(v.text);
    if (v.result != null) return String(v.result);
    if (v.hyperlink != null) return String(v.hyperlink);
  }
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return String(v);
}

function sheetRowsFromWorkbook(wb) {
  const ws = wb.worksheets[0];
  if (!ws) return [];

  const out = [];
  let headers = [];
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const maxCol = Math.max(row.cellCount, headers.length || 0, 1);
    const vals = [];
    for (let c = 1; c <= maxCol; c += 1) {
      const cell = row.getCell(c);
      vals[c - 1] = cellToScalar(cell);
    }
    if (rowNumber === 1) {
      headers = vals.map((v) => String(v ?? '').trim());
    } else {
      const o = {};
      for (let i = 0; i < headers.length; i += 1) {
        const key = String(headers[i] || `col${i + 1}`).trim();
        o[key] = vals[i] ?? '';
      }
      out.push(o);
    }
  });
  return out;
}

/**
 * @param {string | Buffer | Uint8Array} filePathOrBuffer — disk path, or in-memory upload (multer memoryStorage)
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readFirstSheetAsObjects(filePathOrBuffer) {
  const wb = new ExcelJS.Workbook();
  if (typeof filePathOrBuffer === 'string') {
    await wb.xlsx.readFile(filePathOrBuffer);
  } else if (Buffer.isBuffer(filePathOrBuffer) || filePathOrBuffer instanceof Uint8Array) {
    await wb.xlsx.read(Readable.from(filePathOrBuffer));
  } else {
    throw new Error('readFirstSheetAsObjects: expected a file path string or Buffer');
  }
  return sheetRowsFromWorkbook(wb);
}

module.exports = { readFirstSheetAsObjects };
