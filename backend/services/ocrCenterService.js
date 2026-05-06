const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');

function safeJsonParse(s, fallback) {
  try {
    if (!s || typeof s !== 'string') return fallback;
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

/** @returns {Promise<{ text: string, numpages: number }>} */
async function extractPdfTextBuffer(buffer) {
  const pdfParse = require('pdf-parse');
  const data = await pdfParse(buffer, { max: 0 });
  return { text: data.text || '', numpages: data.numpages || 1 };
}

/**
 * Flatten tesseract hierarchy to line-like blocks with bbox when present.
 */
function flattenTesseractBlocks(data) {
  const out = [];
  if (data.lines && Array.isArray(data.lines)) {
    for (const line of data.lines) {
      const t = String(line.text || '').trim();
      if (!t) continue;
      const b = line.bbox || {};
      out.push({ text: t, page: 1, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 });
    }
    if (out.length) return out;
  }
  const walkLines = (node, page = 1) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((n) => walkLines(n, page));
      return;
    }
    if (node.lines && Array.isArray(node.lines)) {
      for (const line of node.lines) {
        const t = String(line.text || '').trim();
        if (!t) continue;
        const b = line.bbox || {};
        out.push({
          text: t,
          page,
          x0: b.x0,
          y0: b.y0,
          x1: b.x1,
          y1: b.y1,
        });
      }
    }
    if (node.blocks) walkLines(node.blocks, page);
  };
  if (data.blocks) walkLines({ blocks: data.blocks }, 1);
  if (!out.length && data.text) {
    for (const line of String(data.text).split(/\r?\n/)) {
      const t = line.trim();
      if (t) out.push({ text: t, page: 1 });
    }
  }
  return out;
}

async function extractImageWithOcr(buffer) {
  const res = await Tesseract.recognize(buffer, 'eng');
  const data = res?.data || {};
  const merged = { text: data.text || '', blocks: data.blocks || [] };
  let lines = flattenTesseractBlocks(merged);
  if (!lines.length && merged.text) {
    lines = merged.text
      .split(/\r?\n/)
      .map((t) => ({ text: t.trim(), page: 1 }))
      .filter((x) => x.text);
  }
  return { rawText: merged.text, blocks: lines, engine: 'tesseract' };
}

function blocksFromPlainText(fullText, numPages = 1) {
  const lines = String(fullText || '').split(/\r?\n/);
  const blocks = [];
  let page = 1;
  for (const line of lines) {
    if (line === '\f' || line.trim() === '\f') {
      page += 1;
      continue;
    }
    if (line.includes('\f')) {
      const parts = line.split('\f');
      for (const p of parts) {
        const t = p.trim();
        if (t) blocks.push({ text: t, page });
        page += 1;
      }
      continue;
    }
    const t = line.trim();
    if (t) blocks.push({ text: t, page: Math.min(page, numPages) });
  }
  if (!blocks.length && fullText?.trim()) {
    blocks.push({ text: fullText.trim(), page: 1 });
  }
  return blocks;
}

function extractByAnchorRestOfLine(text, anchor) {
  if (!anchor) return '';
  const lines = text.split(/\r?\n/);
  const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'i');
  for (const line of lines) {
    if (re.test(line)) {
      const idx = line.search(re);
      let after = line.slice(idx + anchor.length).trim();
      after = after.replace(/^[:#]\s*/, '');
      return after;
    }
  }
  return '';
}

function extractByAnchorNextLine(text, anchor) {
  const lines = text.split(/\r?\n/);
  const esc = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(esc, 'i');
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]) && i + 1 < lines.length) return lines[i + 1].trim();
  }
  return '';
}

function extractByRegex(text, pattern) {
  if (!pattern) return '';
  try {
    const re = new RegExp(pattern, 'im');
    const m = text.match(re);
    if (!m) return '';
    return (m[1] != null ? m[1] : m[0]).trim();
  } catch {
    return '';
  }
}

function applyHeaderField(text, def) {
  if (!def || typeof def !== 'object') return '';
  const mode = String(def.mode || 'anchor_rest_of_line');
  if (mode === 'regex') return extractByRegex(text, def.regex);
  if (mode === 'anchor_next_line') return extractByAnchorNextLine(text, def.anchor || '');
  if (mode === 'literal') return String(def.value || '').trim();
  return extractByAnchorRestOfLine(text, def.anchor || def.label || '');
}

function applyFieldMappings(fullText, fieldMappings) {
  const headers = {};
  const fm = fieldMappings?.headers || fieldMappings || {};
  for (const [key, def] of Object.entries(fm)) {
    if (def && typeof def === 'object') headers[key] = applyHeaderField(fullText, def);
    else headers[key] = String(def || '');
  }
  return headers;
}

function splitLineColumns(line) {
  const s = String(line || '');
  if (s.includes('\t')) return s.split('\t').map((x) => x.trim()).filter(Boolean);
  return s.split(/\s{2,}/).map((x) => x.trim()).filter(Boolean);
}

function parseTableFromText(fullText, tableMappings) {
  const tm = tableMappings || {};
  const startMarker = tm.startMarker || tm.tableStartMarker || tm.headerRowContains || '';
  const endMarker = tm.endMarker || tm.tableEndMarker || '';
  const lines = fullText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let start = 0;
  if (startMarker) {
    const idx = lines.findIndex((l) => l.toLowerCase().includes(String(startMarker).toLowerCase()));
    if (idx >= 0) start = tm.includeHeaderRow ? idx : idx + 1;
  }
  const cols = Array.isArray(tm.columns) ? tm.columns : [];
  const rows = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (endMarker && line.toLowerCase().includes(String(endMarker).toLowerCase())) break;
    if (!line || /^[-_=]+$/.test(line)) continue;
    const cells = splitLineColumns(line);
    if (cells.length < 1) continue;
    const row = {};
    for (const c of cols) {
      const key = c.fieldKey || c.key;
      if (!key) continue;
      const colIdx = Number.isFinite(Number(c.colIndex)) ? Number(c.colIndex) : null;
      if (colIdx != null && colIdx >= 0 && colIdx < cells.length) row[key] = cells[colIdx];
      else if (c.headerLabel) {
        // header row match skipped for data rows
      }
    }
    if (Object.keys(row).length) rows.push(row);
  }
  return rows;
}

function splitDocumentText(fullText, splitRules, documentType) {
  const sr = splitRules || {};
  if (!sr.multipleDocuments && documentType !== 'multiple_po' && documentType !== 'multiple_invoice') {
    return [fullText];
  }
  const strategy = sr.strategy || sr.splitBy || 'by_keyword';
  if (strategy === 'by_page') {
    const pages = String(fullText || '').split(/\f+/).map((p) => p.trim()).filter(Boolean);
    return pages.length ? pages : [fullText];
  }
  if (strategy === 'by_keyword' || strategy === 'by_invoice_number' || strategy === 'by_po_number') {
    const keyword =
      sr.keyword ||
      (strategy === 'by_invoice_number' ? 'Invoice' : strategy === 'by_po_number' ? 'PO' : '') ||
      'Invoice';
    const lines = fullText.split(/\r?\n/);
    const kw = String(keyword).toLowerCase();
    const starts = [];
    lines.forEach((line, i) => {
      if (line.toLowerCase().includes(kw)) starts.push(i);
    });
    if (starts.length <= 1) return [fullText];
    const parts = [];
    for (let s = 0; s < starts.length; s++) {
      const from = starts[s];
      const to = s + 1 < starts.length ? starts[s + 1] : lines.length;
      parts.push(lines.slice(from, to).join('\n'));
    }
    return parts;
  }
  if (strategy === 'by_regex' && sr.regex) {
    try {
      const re = new RegExp(sr.regex, 'gim');
      const bits = fullText.split(re).map((x) => x.trim()).filter(Boolean);
      return bits.length ? bits : [fullText];
    } catch {
      return [fullText];
    }
  }
  return [fullText];
}

function roughConfidence(headers, items) {
  const hVals = Object.values(headers || {}).filter((v) => String(v || '').trim());
  const base = hVals.length ? Math.min(1, 0.35 + hVals.length * 0.08) : 0.25;
  const rowBonus = Math.min(0.35, (items || []).length * 0.02);
  return Math.round(Math.min(0.99, base + rowBonus) * 100) / 100;
}

/**
 * Run extraction pipeline: PDF text or image OCR, optional split, template mapping.
 */
async function runExtractionFromFile(absPath, mimeHint) {
  const ext = path.extname(absPath).toLowerCase();
  const mime = String(mimeHint || '').toLowerCase();
  const buf = fs.readFileSync(absPath);

  let fullText = '';
  let blocks = [];
  let engine = 'pdf-text';
  const warnings = [];

  const isPdf = ext === '.pdf' || mime.includes('pdf');
  const isImage = /\.(png|jpe?g|gif|webp)$/i.test(ext) || /image\//.test(mime);

  if (isPdf) {
    const { text, numpages } = await extractPdfTextBuffer(buf);
    fullText = text;
    if (!fullText || fullText.replace(/\s+/g, '').length < 40) {
      warnings.push('PDF has little or no text layer — scanned PDFs may need page images for OCR.');
      engine = 'pdf-text-empty';
    }
    blocks = blocksFromPlainText(fullText, numpages);
  } else if (isImage) {
    const img = await extractImageWithOcr(buf);
    fullText = img.rawText || '';
    blocks = img.blocks;
    engine = img.engine;
  } else {
    try {
      const { text, numpages } = await extractPdfTextBuffer(buf);
      fullText = text;
      blocks = blocksFromPlainText(fullText, numpages);
    } catch {
      warnings.push('Unsupported file type for extraction.');
    }
  }

  return { fullText, blocks, engine, warnings };
}

function buildPayloadFromTemplateSegment(fullText, template) {
  const fieldMap = safeJsonParse(template.field_mappings_json, {});
  const tableMap = safeJsonParse(template.table_mappings_json, {});
  const headers = applyFieldMappings(fullText, fieldMap);
  const items = parseTableFromText(fullText, tableMap);
  return {
    extracted_header_json: headers,
    extracted_items_json: items,
    confidence_score: roughConfidence(headers, items),
  };
}

module.exports = {
  safeJsonParse,
  extractPdfTextBuffer,
  extractImageWithOcr,
  blocksFromPlainText,
  applyFieldMappings,
  parseTableFromText,
  splitDocumentText,
  runExtractionFromFile,
  buildPayloadFromTemplateSegment,
  roughConfidence,
};
