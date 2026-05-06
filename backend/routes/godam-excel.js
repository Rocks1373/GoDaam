const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const cp = require('child_process');
const { promisify } = require('util');

const mkdir = promisify(fs.mkdir);
const rm = promisify(fs.rm);
const execFile = promisify(cp.execFile);

const router = express.Router();

const PLUGIN_ROOT = path.join(__dirname, '..', '..', 'plugins', 'godam-excel');
const RUN_CLI = path.join(PLUGIN_ROOT, 'service', 'run_cli.py');
const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads', 'godam-excel');

const PYTHON = process.env.GODAM_EXCEL_PYTHON || 'python3';

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

function makeUpload(jobDir) {
  const inputDir = path.join(jobDir, 'input');
  const dnDir = path.join(inputDir, 'DSA');

  const storage = multer.diskStorage({
    destination(req, file, cb) {
      if (file.fieldname === 'dn') return cb(null, dnDir);
      return cb(null, inputDir);
    },
    filename(req, file, cb) {
      if (MASTER_NAMES[file.fieldname]) {
        return cb(null, MASTER_NAMES[file.fieldname]);
      }
      const safe = path.basename(file.originalname || '').replace(/[^\w.\- ]+/g, '_').slice(0, 180);
      return cb(null, safe || `dn_${Date.now()}.xlsx`);
    },
  });

  return multer({
    storage,
    limits: { fileSize: 40 * 1024 * 1024 },
    fileFilter(req, file, cb) {
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
    { name: 'dn', maxCount: 100 },
  ]);
}

/**
 * POST /match — multipart uploads for GoDam-1.0 matching.
 * Fields: summary, po, so, vcust, contracts, accessories (one .xlsx each), dn (one or more DSA DN files).
 * Response: ZIP of output_generated.xlsx, rejected_rows.xlsx, summary_report.xlsx
 */
router.post('/match', (req, res) => {
  const jobId = crypto.randomUUID();
  const jobDir = path.join(UPLOAD_ROOT, jobId);
  const inputDir = path.join(jobDir, 'input');
  const dnDir = path.join(inputDir, 'DSA');
  const outputDir = path.join(jobDir, 'output');
  let uploadFinished = false;

  Promise.resolve()
    .then(() =>
      mkdir(dnDir, { recursive: true }).then(() => mkdir(outputDir, { recursive: true }))
    )
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
      for (const f of MASTER_FIELDS) {
        const p = path.join(inputDir, MASTER_NAMES[f]);
        if (!fs.existsSync(p)) {
          throw new Error(`Missing required file field "${f}" (${MASTER_NAMES[f]})`);
        }
      }

      let dns = [];
      try {
        dns = fs.readdirSync(dnDir).filter((name) => /\.xlsx$/i.test(name) || /\.xls$/i.test(name));
      } catch {
        dns = [];
      }
      if (dns.length === 0) {
        throw new Error('At least one DN file is required under field "dn" (.xlsx)');
      }

      if (!fs.existsSync(RUN_CLI)) {
        throw new Error(`GoDam Excel plugin missing: ${RUN_CLI}`);
      }

      let py;
      try {
        py = await execFile(PYTHON, [RUN_CLI, inputDir, outputDir], {
          cwd: PLUGIN_ROOT,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONPATH: PLUGIN_ROOT },
        });
      } catch (e) {
        const stderr = e.stderr?.toString() || '';
        const stdout = e.stdout?.toString().trim() || '';
        let fromJson = null;
        try {
          fromJson = JSON.parse(stdout || '{}');
        } catch {
          /* ignore */
        }
        if (fromJson && fromJson.error) throw new Error(fromJson.error);
        throw new Error(`Python matcher failed: ${e.message}${stderr ? ` — ${stderr.slice(0, 2000)}` : ''}`);
      }

      const outText = py.stdout.trim();
      let meta;
      try {
        meta = JSON.parse(outText || '{}');
      } catch {
        throw new Error(`Matcher returned non-JSON: ${String(outText).slice(0, 500)}`);
      }
      if (meta.error) {
        throw new Error(meta.error + (meta.traceback ? `\n${meta.traceback}` : ''));
      }

      const zipPath = path.join(jobDir, 'godam-match-results.zip');
      const expected = ['output_generated.xlsx', 'rejected_rows.xlsx', 'summary_report.xlsx'];
      for (const f of expected) {
        if (!fs.existsSync(path.join(outputDir, f))) {
          throw new Error(`Expected output missing: ${f}`);
        }
      }

      try {
        await execFile('/usr/bin/zip', ['-q', '-j', zipPath, ...expected], { cwd: outputDir });
      } catch {
        await execFile('zip', ['-q', '-j', zipPath, ...expected], { cwd: outputDir }).catch(() => {
          throw new Error('zip command failed; install zip CLI or unzip outputs manually.');
        });
      }

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="godam-match-results.zip"');
      res.setHeader('X-Godam-Excel-Meta', Buffer.from(JSON.stringify(meta), 'utf8').toString('base64'));

      const stream = fs.createReadStream(zipPath);
      stream.pipe(res);
      stream.on('error', () => {
        /* ignore — response may already started */
      });
      stream.on('close', () => {
        rm(jobDir, { recursive: true, force: true }).catch(() => {});
      });
    })
    .catch((e) => {
      if (uploadFinished) {
        rm(jobDir, { recursive: true, force: true }).catch(() => {});
      }
      if (!res.headersSent) {
        res.status(400).json({ error: e.message || 'GoDam Excel match failed' });
      }
    });
});

router.get('/health', (req, res) => {
  const ok = fs.existsSync(RUN_CLI) && fs.existsSync(path.join(PLUGIN_ROOT, 'core', 'run_logic.py'));
  res.json({
    plugin: 'godam-excel',
    ok,
    pluginRoot: PLUGIN_ROOT,
    python: PYTHON,
  });
});

module.exports = router;
