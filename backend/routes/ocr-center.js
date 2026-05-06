const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { promisify } = require('util');
const XLSX = require('xlsx');

const db = require('../db');
const {
  safeJsonParse,
  runExtractionFromFile,
  splitDocumentText,
  buildPayloadFromTemplateSegment,
  roughConfidence,
} = require('../services/ocrCenterService');

const router = express.Router();
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'ocr');
fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

function safeOriginalName(name) {
  return String(name || 'document').replace(/[^a-zA-Z0-9._\- ]/g, '_').slice(0, 200);
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_ROOT),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '') || '';
    const base = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    cb(null, `${base}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok =
      /\.pdf$/i.test(file.originalname || '') ||
      /\.(png|jpe?g|gif|webp)$/i.test(file.originalname || '') ||
      /pdf|image\//i.test(file.mimetype || '');
    if (!ok) return cb(new Error('Only PDF, JPG, PNG, GIF, WebP are allowed'));
    cb(null, true);
  },
});

function relUploadPath(absPath) {
  const rel = path.relative(path.join(__dirname, '..'), absPath).replace(/\\/g, '/');
  return rel.startsWith('..') ? path.basename(absPath) : rel;
}

// --- Templates ---
router.get('/templates', async (req, res) => {
  try {
    const activeOnly = String(req.query.active || '') === '1' || String(req.query.active || '') === 'true';
    const rows = await dbAll(
      `SELECT id, template_name, party_name, document_type, description, field_mappings_json, table_mappings_json,
              split_rules_json, sample_file_path, is_active, created_by, created_at, updated_at
       FROM ocr_templates
       ${activeOnly ? 'WHERE is_active = 1' : ''}
       ORDER BY template_name ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const uid = req.user?.id || null;
    const b = req.body || {};
    const name = String(b.template_name || '').trim();
    if (!name) return res.status(400).json({ error: 'template_name required' });
    const docType = String(b.document_type || '').trim() || 'vendor_invoice';
    const fm = typeof b.field_mappings_json === 'string' ? b.field_mappings_json : JSON.stringify(b.field_mappings_json || {});
    const tm = typeof b.table_mappings_json === 'string' ? b.table_mappings_json : JSON.stringify(b.table_mappings_json || {});
    const sr =
      b.split_rules_json === undefined || b.split_rules_json === null
        ? null
        : typeof b.split_rules_json === 'string'
          ? b.split_rules_json
          : JSON.stringify(b.split_rules_json);
    await dbRun(
      `INSERT INTO ocr_templates (
        template_name, party_name, document_type, description, field_mappings_json, table_mappings_json,
        split_rules_json, sample_file_path, is_active, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        name,
        b.party_name || null,
        docType,
        b.description || null,
        fm,
        tm,
        sr,
        b.sample_file_path || null,
        b.is_active === 0 || b.is_active === false ? 0 : 1,
        uid,
      ]
    );
    const row = await dbGet('SELECT * FROM ocr_templates WHERE id = last_insert_rowid()');
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const cur = await dbGet('SELECT * FROM ocr_templates WHERE id = ?', [id]);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const name = b.template_name != null ? String(b.template_name).trim() : cur.template_name;
    if (!name) return res.status(400).json({ error: 'template_name required' });
    const fm =
      b.field_mappings_json !== undefined
        ? typeof b.field_mappings_json === 'string'
          ? b.field_mappings_json
          : JSON.stringify(b.field_mappings_json)
        : cur.field_mappings_json;
    const tm =
      b.table_mappings_json !== undefined
        ? typeof b.table_mappings_json === 'string'
          ? b.table_mappings_json
          : JSON.stringify(b.table_mappings_json)
        : cur.table_mappings_json;
    const sr =
      b.split_rules_json !== undefined
        ? b.split_rules_json === null
          ? null
          : typeof b.split_rules_json === 'string'
            ? b.split_rules_json
            : JSON.stringify(b.split_rules_json)
        : cur.split_rules_json;
    await dbRun(
      `UPDATE ocr_templates SET
        template_name = ?, party_name = ?, document_type = ?, description = ?,
        field_mappings_json = ?, table_mappings_json = ?, split_rules_json = ?,
        sample_file_path = COALESCE(?, sample_file_path), is_active = COALESCE(?, is_active),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`,
      [
        name,
        b.party_name !== undefined ? b.party_name : cur.party_name,
        b.document_type != null ? String(b.document_type) : cur.document_type,
        b.description !== undefined ? b.description : cur.description,
        fm,
        tm,
        sr,
        b.sample_file_path,
        b.is_active !== undefined ? (b.is_active ? 1 : 0) : cur.is_active,
        id,
      ]
    );
    const row = await dbGet('SELECT * FROM ocr_templates WHERE id = ?', [id]);
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    await dbRun('DELETE FROM ocr_templates WHERE id = ?', [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Settings ---
router.get('/settings', async (_req, res) => {
  try {
    const row = await dbGet('SELECT settings_json, updated_at FROM ocr_settings WHERE id = 1');
    res.json(safeJsonParse(row?.settings_json, {}));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings', async (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    await dbRun('UPDATE ocr_settings SET settings_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1', [
      JSON.stringify(payload),
    ]);
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Upload & run ---
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Missing file (field: file)' });
    const uid = req.user?.id || null;
    const document_type = String(req.body.document_type || 'vendor_invoice').trim() || 'vendor_invoice';
    const template_id = req.body.template_id ? Number(req.body.template_id) : null;
    const rel = relUploadPath(req.file.path);
    await dbRun(
      `INSERT INTO ocr_results (
        template_id, document_type, original_file_name, file_path, status, created_by, created_at
      ) VALUES (?, ?, ?, ?, 'Draft', ?, CURRENT_TIMESTAMP)`,
      [template_id || null, document_type, safeOriginalName(req.file.originalname), rel, uid]
    );
    const row = await dbGet('SELECT * FROM ocr_results WHERE id = last_insert_rowid()');
    res.status(201).json({
      ...row,
      previewUrl: `/${row.file_path}`.replace(/\/+/g, '/'),
    });
  } catch (e) {
    if (req.file?.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch {
        // ignore
      }
    }
    res.status(500).json({ error: e.message });
  }
});

router.post('/run', async (req, res) => {
  try {
    const resultId = Number(req.body.resultId);
    if (!resultId) return res.status(400).json({ error: 'resultId required' });
    const row = await dbGet('SELECT * FROM ocr_results WHERE id = ?', [resultId]);
    if (!row) return res.status(404).json({ error: 'Result not found' });

    const absPath = path.isAbsolute(row.file_path) ? row.file_path : path.join(__dirname, '..', row.file_path);
    if (!fs.existsSync(absPath)) return res.status(400).json({ error: 'Uploaded file missing on server' });

    const templateId = req.body.templateId != null ? Number(req.body.templateId) : row.template_id;
    let template = null;
    if (templateId) {
      template = await dbGet('SELECT * FROM ocr_templates WHERE id = ?', [templateId]);
    }

    const inlineFm = req.body.field_mappings_json;
    const inlineTm = req.body.table_mappings_json;
    const inlineSplit = req.body.split_rules_json;

    const mappingTemplate =
      template ||
      (inlineFm || inlineTm
        ? {
            field_mappings_json:
              typeof inlineFm === 'string' ? inlineFm : JSON.stringify(inlineFm || {}),
            table_mappings_json:
              typeof inlineTm === 'string' ? inlineTm : JSON.stringify(inlineTm || {}),
          }
        : { field_mappings_json: '{}', table_mappings_json: '{}' });

    let splitRules = null;
    if (inlineSplit !== undefined) {
      splitRules = typeof inlineSplit === 'string' ? safeJsonParse(inlineSplit, {}) : inlineSplit;
    } else if (template?.split_rules_json) {
      splitRules = safeJsonParse(template.split_rules_json, null);
    }

    if (req.body.multipleDocuments === 'yes' || req.body.multipleDocuments === true) {
      splitRules = splitRules || {};
      splitRules.multipleDocuments = true;
      if (req.body.splitStrategy) splitRules.strategy = req.body.splitStrategy;
      if (req.body.splitKeyword) splitRules.keyword = req.body.splitKeyword;
    }

    const docType = String(req.body.document_type || row.document_type);

    const { fullText, blocks, engine, warnings } = await runExtractionFromFile(absPath, req.body.mimeType || '');

    const rawOcr = JSON.stringify({
      engine,
      warnings,
      blockCount: blocks.length,
      blocks: blocks.slice(0, 800),
      textPreview: fullText.slice(0, 120000),
    });

    const segments = splitDocumentText(fullText, splitRules, docType);
    const payloads = segments.map((seg) => buildPayloadFromTemplateSegment(seg, mappingTemplate));

    const first = payloads[0] || {
      extracted_header_json: {},
      extracted_items_json: [],
      confidence_score: 0,
    };

    await dbRun(
      `UPDATE ocr_results SET
        template_id = COALESCE(?, template_id),
        document_type = ?,
        extracted_header_json = ?,
        extracted_items_json = ?,
        raw_ocr_json = ?,
        confidence_score = ?,
        status = 'Draft',
        created_at = created_at
      WHERE id = ?`,
      [
        templateId || null,
        docType,
        JSON.stringify(first.extracted_header_json || {}),
        JSON.stringify(first.extracted_items_json || []),
        rawOcr,
        first.confidence_score ?? roughConfidence(first.extracted_header_json, first.extracted_items_json),
        resultId,
      ]
    );

    const createdIds = [resultId];
    const uid = req.user?.id || null;

    for (let i = 1; i < payloads.length; i++) {
      const p = payloads[i];
      await dbRun(
        `INSERT INTO ocr_results (
          template_id, document_type, original_file_name, file_path,
          extracted_header_json, extracted_items_json, raw_ocr_json, confidence_score, status, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Draft', ?, CURRENT_TIMESTAMP)`,
        [
          templateId || null,
          docType,
          row.original_file_name,
          row.file_path,
          JSON.stringify(p.extracted_header_json || {}),
          JSON.stringify(p.extracted_items_json || []),
          null,
          p.confidence_score ?? roughConfidence(p.extracted_header_json, p.extracted_items_json),
          uid,
        ]
      );
      const nr = await dbGet('SELECT id FROM ocr_results WHERE id = last_insert_rowid()');
      if (nr?.id) createdIds.push(nr.id);
    }

    const updated = await dbGet('SELECT * FROM ocr_results WHERE id = ?', [resultId]);
    res.json({
      result: updated,
      segmentCount: segments.length,
      resultIds: createdIds,
      engine,
      warnings,
      blocks: blocks.slice(0, 500),
    });
  } catch (e) {
    console.error('[ocr-center run]', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/save-result', async (req, res) => {
  try {
    const id = Number(req.body.id);
    if (!id) return res.status(400).json({ error: 'id required' });
    const row = await dbGet('SELECT * FROM ocr_results WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const headers = req.body.extracted_header_json;
    const items = req.body.extracted_items_json;
    const status = req.body.status != null ? String(req.body.status) : row.status;
    const allowed = ['Draft', 'Reviewed', 'Saved', 'Exported'];
    const st = allowed.includes(status) ? status : row.status;
    await dbRun(
      `UPDATE ocr_results SET
        extracted_header_json = COALESCE(?, extracted_header_json),
        extracted_items_json = COALESCE(?, extracted_items_json),
        status = ?,
        template_id = COALESCE(?, template_id)
      WHERE id = ?`,
      [
        headers !== undefined ? (typeof headers === 'string' ? headers : JSON.stringify(headers)) : null,
        items !== undefined ? (typeof items === 'string' ? items : JSON.stringify(items)) : null,
        st,
        req.body.template_id != null ? Number(req.body.template_id) : null,
        id,
      ]
    );
    const out = await dbGet('SELECT * FROM ocr_results WHERE id = ?', [id]);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/results', async (req, res) => {
  try {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const rows = await dbAll(
      `SELECT id, template_id, document_type, original_file_name, file_path, status, confidence_score, created_at
       FROM ocr_results ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/results/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await dbGet('SELECT * FROM ocr_results WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const raw = safeJsonParse(row.raw_ocr_json, null);
    res.json({
      ...row,
      previewUrl: row.file_path ? `/${String(row.file_path).replace(/^\/+/, '')}` : null,
      raw_ocr: raw,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/results/:id/export-excel', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await dbGet('SELECT * FROM ocr_results WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const headers = safeJsonParse(row.extracted_header_json, {});
    const items = safeJsonParse(row.extracted_items_json, []);
    const sheet1 = XLSX.utils.json_to_sheet(
      Object.entries(headers).map(([k, v]) => ({ field: k, value: v }))
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet1, 'Header');
    if (items.length) {
      const sheet2 = XLSX.utils.json_to_sheet(items);
      XLSX.utils.book_append_sheet(wb, sheet2, 'Items');
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fname = `ocr-result-${id}.xlsx`;
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/results/:id/send-to-inbound', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await dbGet('SELECT id FROM ocr_results WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({
      ok: true,
      integration: 'deferred',
      message:
        'OCR does not auto-post to inbound. Export to Excel and use the existing Inbound upload, or call a future API once mapped columns are finalized.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/results/:id/send-to-outbound', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const row = await dbGet('SELECT id FROM ocr_results WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json({
      ok: true,
      integration: 'deferred',
      message:
        'OCR does not auto-post to outbound. Export to Excel and use Outbound upload, or integrate later when column mapping is approved.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.use((err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  return res.status(400).json({ error: err.message || 'Bad request' });
});

module.exports = router;
