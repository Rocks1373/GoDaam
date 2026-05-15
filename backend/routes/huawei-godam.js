const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const cp = require('child_process');
const { promisify } = require('util');

const hgDb = require('../huaweiGodamDb');
const { importHuaweiGodamBatch, PLUGIN_ROOT, PYTHON } = require('../services/huaweiGodamImporter');

const router = express.Router();
const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);
const execFile = promisify(cp.execFile);
const dbRun = promisify(hgDb.run.bind(hgDb));
const dbGet = promisify(hgDb.get.bind(hgDb));
const dbAll = promisify(hgDb.all.bind(hgDb));

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'huawei-godam');
const MATCHER_CLI = path.join(PLUGIN_ROOT, 'scripts', 'run_matcher_cli.py');

const MASTER_FIELDS = ['summary', 'po', 'so', 'vcust', 'contracts', 'accessories'];
const MASTER_NAMES = {
  summary: 'INPUT.xlsx',
  po: 'PO.XLSX',
  so: 'SO.XLSX',
  vcust: 'VCUST.XLSX',
  contracts: 'CONRACTS.xlsx',
  accessories: 'ASS.xlsx',
};

fs.mkdirSync(UPLOAD_ROOT, { recursive: true });

function extractLastJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith('{') || !l.endsWith('}')) continue;
    try {
      return JSON.parse(l);
    } catch {
      // continue scanning upward
    }
  }
  // fallback: attempt whole string parse
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function makeUpload(jobDir) {
  const inputDir = path.join(jobDir, 'input');
  const dnDir = path.join(inputDir, 'DSA');

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      if (file.fieldname === 'dn') return cb(null, dnDir);
      return cb(null, inputDir);
    },
    filename(req, file, cb) {
      if (MASTER_NAMES[file.fieldname]) return cb(null, MASTER_NAMES[file.fieldname]);
      const safe = path.basename(file.originalname || '').replace(/[^\w.\- ]+/g, '_').slice(0, 180);
      return cb(null, safe || `dn_${Date.now()}.xlsx`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter(req, file, cb) {
      if (file.fieldname === 'rules') {
        const n = String(file.originalname || '').toLowerCase();
        if (!n.endsWith('.json')) return cb(new Error('rules: only .json'));
        return cb(null, true);
      }
      if (file.fieldname === 'dn' || MASTER_FIELDS.includes(file.fieldname)) {
        const n = String(file.originalname || '').toLowerCase();
        if (!n.endsWith('.xlsx') && !n.endsWith('.xls')) {
          return cb(new Error(`${file.fieldname}: only .xlsx / .xls`));
        }
      }
      return cb(null, true);
    },
  }).fields([
    { name: 'summary', maxCount: 1 },
    { name: 'po', maxCount: 1 },
    { name: 'so', maxCount: 1 },
    { name: 'vcust', maxCount: 1 },
    { name: 'contracts', maxCount: 1 },
    { name: 'accessories', maxCount: 1 },
    { name: 'rules', maxCount: 1 },
    { name: 'dn', maxCount: 150 },
  ]);
}

function fieldOriginal(files, name) {
  const f = files?.[name]?.[0];
  return f?.originalname ? String(f.originalname) : null;
}

function insertBatchRow(payload) {
  return new Promise((resolve, reject) => {
    hgDb.run(
      `INSERT INTO hg_processing_batch (
        created_by_user_id, status, summary_original_filename, po_original_filename, so_original_filename,
        vcust_original_filename, contracts_original_filename, accessories_original_filename,
        rules_json, storage_dir_relative, started_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`,
      [
        payload.created_by_user_id,
        payload.status,
        payload.summary_original_filename,
        payload.po_original_filename,
        payload.so_original_filename,
        payload.vcust_original_filename,
        payload.contracts_original_filename,
        payload.accessories_original_filename,
        payload.rules_json,
        payload.storage_dir_relative,
      ],
      function cb(err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

async function updateBatch(id, fields) {
  const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
  if (!keys.length) return;
  const set = keys.map((k) => `${k} = ?`).join(', ');
  const vals = keys.map((k) => fields[k]);
  vals.push(id);
  await dbRun(`UPDATE hg_processing_batch SET ${set} WHERE id = ?`, vals);
}

/**
 * POST /batches — multipart: masters + dn files; optional rules.json.
 * Runs matcher + imports into huawei_godam.db.
 */
router.post('/batches', (req, res) => {
  const batchUid = crypto.randomUUID();
  const jobDir = path.join(UPLOAD_ROOT, batchUid);
  const inputDir = path.join(jobDir, 'input');
  const dnDir = path.join(inputDir, 'DSA');
  const outputDir = path.join(jobDir, 'output');
  const storageRelative = path.relative(path.join(__dirname, '..'), jobDir).replace(/\\/g, '/');

  let uploadFinished = false;

  Promise.resolve()
    .then(() => mkdir(dnDir, { recursive: true }).then(() => mkdir(outputDir, { recursive: true })))
    .then(
      () =>
        new Promise((resolve, reject) => {
          const upload = makeUpload(jobDir);
          upload(req, res, (err) => {
            if (err) return reject(err);
            uploadFinished = true;
            resolve();
          });
        })
    )
    .then(async () => {
      const files = req.files || {};
      for (const f of MASTER_FIELDS) {
        const p = path.join(inputDir, MASTER_NAMES[f]);
        if (!fs.existsSync(p)) throw new Error(`Missing required file field "${f}" (${MASTER_NAMES[f]})`);
      }
      let dns = [];
      try {
        dns = fs.readdirSync(dnDir).filter((n) => /\.xlsx$/i.test(n) || /\.xls$/i.test(n));
      } catch {
        dns = [];
      }
      if (dns.length === 0) throw new Error('At least one DN file is required (field "dn", .xlsx)');

      let rulesJsonText;
      const rulesUpload = files.rules?.[0]?.path;
      if (rulesUpload && fs.existsSync(rulesUpload)) {
        rulesJsonText = await readFile(rulesUpload, 'utf8');
      } else {
        rulesJsonText = await readFile(path.join(PLUGIN_ROOT, 'config', 'rules.json'), 'utf8');
      }
      const rulesPath = path.join(jobDir, 'rules_snapshot.json');
      await promisify(fs.writeFile)(rulesPath, rulesJsonText, 'utf8');

      if (!fs.existsSync(MATCHER_CLI)) {
        throw new Error(`Matcher CLI missing: ${MATCHER_CLI}. Install GoDam-1.0 under plugins/GoDam-1.0 (canonical)`);
      }

      const batchId = await insertBatchRow({
        created_by_user_id: req.user?.id ? Number(req.user.id) : null,
        status: 'running',
        summary_original_filename: fieldOriginal(files, 'summary'),
        po_original_filename: fieldOriginal(files, 'po'),
        so_original_filename: fieldOriginal(files, 'so'),
        vcust_original_filename: fieldOriginal(files, 'vcust'),
        contracts_original_filename: fieldOriginal(files, 'contracts'),
        accessories_original_filename: fieldOriginal(files, 'accessories'),
        rules_json: rulesJsonText,
        storage_dir_relative: storageRelative,
      });

      let stdout = '';
      try {
        const py = await execFile(PYTHON, [MATCHER_CLI, inputDir, outputDir, rulesPath], {
          cwd: PLUGIN_ROOT,
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, PYTHONPATH: PLUGIN_ROOT, PYTHONUNBUFFERED: '1' },
        });
        stdout = py.stdout || '';
      } catch (e) {
        const stderr = e.stderr?.toString() || '';
        const out = e.stdout?.toString() || '';
        const parsed = extractLastJsonObject(out);
        const msg = parsed?.error || e.message || 'Matcher failed';
        await updateBatch(batchId, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: `${msg}${stderr ? `\n${stderr.slice(0, 4000)}` : ''}`,
          matcher_stdout: String(out).slice(0, 12000),
        });
        const detail = [
          msg,
          stderr ? `\n--- stderr ---\n${stderr.slice(0, 8000)}` : '',
          out ? `\n--- stdout ---\n${String(out).slice(0, 8000)}` : '',
        ]
          .filter(Boolean)
          .join('');
        throw new Error(detail);
      }

      let stats = {};
      try {
        const parsed = extractLastJsonObject(stdout);
        stats = parsed || {};
      } catch {
        stats = {};
      }
      if (stats.error) {
        await updateBatch(batchId, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: stats.error,
          matcher_stdout: String(stdout).slice(0, 12000),
        });
        throw new Error(stats.error);
      }

      await importHuaweiGodamBatch(batchId, storageRelative);

      await updateBatch(batchId, {
        status: 'completed',
        completed_at: new Date().toISOString(),
        matcher_stats_json: JSON.stringify(stats),
        matcher_stdout: String(stdout).slice(0, 12000),
      });

      res.status(201).json({
        id: batchId,
        uid: batchUid,
        status: 'completed',
        stats,
        storage_dir_relative: storageRelative,
      });
    })
    .catch((e) => {
      if (!res.headersSent) res.status(400).json({ error: e.message || 'Huawei GoDam batch failed' });
    });
});

router.get('/batches', async (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = await dbAll(
      `SELECT id, created_at, started_at, completed_at, status, created_by_user_id,
              summary_original_filename, po_original_filename, error_message,
              storage_dir_relative, matcher_stats_json
       FROM hg_processing_batch ORDER BY id DESC LIMIT ?`,
      [limit]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/batches/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const batch = await dbGet(`SELECT * FROM hg_processing_batch WHERE id = ?`, [id]);
    if (!batch) return res.status(404).json({ error: 'Not found' });

    const artifacts = await dbAll(`SELECT id, kind, relative_path FROM hg_artifact WHERE batch_id = ?`, [id]);
    const counts = await dbGet(
      `SELECT
        (SELECT COUNT(*) FROM hg_summary_row WHERE batch_id = ?) AS summary_rows,
        (SELECT COUNT(*) FROM hg_match_detail WHERE batch_id = ?) AS match_details,
        (SELECT COUNT(*) FROM hg_dn_document WHERE batch_id = ?) AS dn_documents,
        (SELECT COUNT(*) FROM hg_po_line WHERE batch_id = ?) AS po_lines,
        (SELECT COUNT(*) FROM hg_contract_row WHERE batch_id = ?) AS contracts
      `,
      [id, id, id, id, id]
    );

    let matcher_stats = null;
    try {
      matcher_stats = batch.matcher_stats_json ? JSON.parse(batch.matcher_stats_json) : null;
    } catch {
      matcher_stats = null;
    }

    res.json({
      batch: { ...batch, matcher_stats_json: undefined, matcher_stats },
      artifacts,
      counts,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/health', async (_req, res) => {
  const pluginOk = fs.existsSync(path.join(PLUGIN_ROOT, 'Home.py')) && fs.existsSync(MATCHER_CLI);
  res.json({
    ok: true,
    pluginRoot: PLUGIN_ROOT,
    matcherCli: MATCHER_CLI,
    python: PYTHON,
    pluginReady: pluginOk,
  });
});

// ============================================================
// Customer Order List (new DB design) — PO -> DSA -> Items
// Business rules:
// - exclude POs starting with 5500 or 5100
// - DSA dropdown shows only status='Received'
// - Delivered DSAs/items are not returned for DN creation
// ============================================================

function isExcludedPo(po) {
  const s = String(po || '').trim();
  return s.startsWith('5500') || s.startsWith('5100');
}

router.get('/customer-orders/po-options', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const lim = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const rows = await dbAll(
      `
      SELECT DISTINCT TRIM(COALESCE(gapp_po_number,'')) AS po
      FROM huawei_customer_order_header
      WHERE TRIM(COALESCE(gapp_po_number,'')) != ''
        AND (? = '' OR gapp_po_number LIKE ?)
      ORDER BY po ASC
      LIMIT ?
      `,
      [q, q ? `%${q}%` : '', lim]
    );
    const pos = (rows || []).map((r) => r.po).filter((po) => po && !isExcludedPo(po));
    res.json({ pos, count: pos.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/customer-orders/:po/dsa', async (req, res) => {
  try {
    const po = String(req.params.po || '').trim();
    if (!po) return res.status(400).json({ error: 'Invalid PO' });
    if (isExcludedPo(po)) return res.json({ po, dsas: [], count: 0, excluded: true });
    const rows = await dbAll(
      `
      SELECT id, dsa_number, bill_no_pl_no, status, received_date, delivered_date
      FROM huawei_customer_order_header
      WHERE TRIM(COALESCE(gapp_po_number,'')) = ?
        AND lower(COALESCE(status,'')) = 'received'
        AND TRIM(COALESCE(dsa_number,'')) != ''
      ORDER BY dsa_number ASC, id ASC
      `,
      [po]
    );
    res.json({ po, dsas: rows || [], count: (rows || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/customer-orders/:po/dsa/:dsa/items', async (req, res) => {
  try {
    const po = String(req.params.po || '').trim();
    const dsa = String(req.params.dsa || '').trim();
    if (!po || !dsa) return res.status(400).json({ error: 'Invalid PO/DSA' });
    if (isExcludedPo(po)) return res.json({ po, dsa, items: [], count: 0, excluded: true });
    const rows = await dbAll(
      `
      SELECT *
      FROM huawei_delivery_item_details
      WHERE TRIM(COALESCE(gapp_po_number,'')) = ?
        AND TRIM(COALESCE(dsa_number,'')) = ?
        AND lower(COALESCE(status,'')) = 'received'
      ORDER BY id ASC
      `,
      [po, dsa]
    );
    res.json({ po, dsa, items: rows || [], count: (rows || []).length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
