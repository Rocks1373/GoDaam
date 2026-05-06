const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const cp = require('child_process');
const { promisify } = require('util');

const hgDb = require('../huaweiGodamDb');
const dbRun = promisify(hgDb.run.bind(hgDb));

const BACKEND_ROOT = path.join(__dirname, '..');
const PLUGIN_ROOT = path.join(BACKEND_ROOT, '..', 'plugins', 'GoDam-1.0');
const PYTHON = process.env.HUAWEI_GODAM_PYTHON || process.env.GODAM_EXCEL_PYTHON || 'python3';

function sheetToAoA(ws) {
  if (!ws || !ws['!ref']) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
}

function normCell(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function deleteBatchChildren(batchId) {
  await dbRun(`DELETE FROM hg_dn_line WHERE dn_document_id IN (SELECT id FROM hg_dn_document WHERE batch_id = ?)`, [
    batchId,
  ]);
  await dbRun(`DELETE FROM hg_dn_document WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_contract_row WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_po_line WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_so_line WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_vcust_row WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_summary_row WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_match_detail WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_match_ignored WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_duplicate_dn_po WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_po_matchrollup WHERE batch_id = ?`, [batchId]);
  await dbRun(`DELETE FROM hg_artifact WHERE batch_id = ?`, [batchId]);
}

async function importArtifacts(batchId, batchAbsDir) {
  const outDir = path.join(batchAbsDir, 'output');
  const kinds = [
    ['output_generated', 'output_generated.xlsx'],
    ['rejected_rows', 'rejected_rows.xlsx'],
    ['summary_report', 'summary_report.xlsx'],
  ];
  for (const [kind, fname] of kinds) {
    const abs = path.join(outDir, fname);
    if (!fs.existsSync(abs)) continue;
    const rel = path.relative(BACKEND_ROOT, abs).replace(/\\/g, '/');
    await dbRun(`INSERT INTO hg_artifact (batch_id, kind, relative_path) VALUES (?, ?, ?)`, [
      batchId,
      kind,
      rel,
    ]);
  }
}

async function importOutputSheets(batchId, batchAbsDir) {
  const outGen = path.join(batchAbsDir, 'output', 'output_generated.xlsx');
  if (!fs.existsSync(outGen)) return;

  const wb = XLSX.readFile(outGen);

  const sumWs = wb.Sheets.Summary || wb.Sheets.summary;
  if (sumWs) {
    const rows = sheetToAoA(sumWs);
    if (rows.length > 1) {
      const hdr = rows[0].map((h) => String(h || '').trim().toLowerCase());
      const idx = (labels) => {
        for (const lb of labels) {
          const i = hdr.findIndex((h) => h.includes(lb) || h.replace(/\s/g, '') === lb.replace(/\s/g, ''));
          if (i >= 0) return i;
        }
        return -1;
      };
      const ia = idx(['account']);
      const ic = idx(['contract no', 'contractno']);
      const icn = idx(['contract name']);
      const im = idx(['mr number']);
      const idn = idx(['dn number']);
      const icbm = idx(['cbm']);
      const ib = idx(['batch no']);
      const idist = idx(['distributor']);
      const ir = idx(['remarks']);
      const ipo = idx(['po']);
      const iso = idx(['so']);
      const ibox = idx(['number_of_boxes', 'number of boxes']);

      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        await dbRun(
          `INSERT INTO hg_summary_row (batch_id, account, contract_no, contract_name, mr_number, dn_number, cbm, batch_no, distributor, remarks, po, so, number_of_boxes)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            batchId,
            ia >= 0 ? normCell(row[ia]) : null,
            ic >= 0 ? normCell(row[ic]) : null,
            icn >= 0 ? normCell(row[icn]) : null,
            im >= 0 ? normCell(row[im]) : null,
            idn >= 0 ? normCell(row[idn]) : null,
            icbm >= 0 ? normCell(row[icbm]) : null,
            ib >= 0 ? normCell(row[ib]) : null,
            idist >= 0 ? normCell(row[idist]) : null,
            ir >= 0 ? normCell(row[ir]) : null,
            ipo >= 0 ? normCell(row[ipo]) : null,
            iso >= 0 ? normCell(row[iso]) : null,
            ibox >= 0 ? numOrNull(row[ibox]) : null,
          ]
        );
      }
    }
  }

  const detWs = wb.Sheets.Details || wb.Sheets.details;
  if (detWs) {
    const rows = sheetToAoA(detWs);
    if (rows.length > 1) {
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const remark = normCell(row[7]);
        if (!remark) continue;
        await dbRun(
          `INSERT INTO hg_match_detail (batch_id, po_number, dn_number, contract_number, part_number, description, dn_qty, po_open_qty, remark)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            batchId,
            normCell(row[0]),
            normCell(row[1]),
            normCell(row[2]),
            normCell(row[3]),
            normCell(row[4]),
            numOrNull(row[5]),
            numOrNull(row[6]),
            remark,
          ]
        );
      }
    }
  }

  const ignWs = wb.Sheets['Ignored Items'] || wb.Sheets['Ignored'];
  if (ignWs) {
    const rows = sheetToAoA(ignWs);
    if (rows.length > 1) {
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        await dbRun(
          `INSERT INTO hg_match_ignored (batch_id, source, dn_number, contract_number, po_number, part_number, description, dn_qty, po_qty, reason)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            batchId,
            normCell(row[0]),
            normCell(row[1]),
            normCell(row[2]),
            normCell(row[3]),
            normCell(row[4]),
            normCell(row[5]),
            numOrNull(row[6]),
            numOrNull(row[7]),
            normCell(row[8]),
          ]
        );
      }
    }
  }

  const rejPath = path.join(batchAbsDir, 'output', 'rejected_rows.xlsx');
  if (fs.existsSync(rejPath)) {
    const rwb = XLSX.readFile(rejPath);
    const ws = rwb.Sheets.Rejected || rwb.Sheets.rejected;
    if (ws) {
      const rows = sheetToAoA(ws);
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        await dbRun(
          `INSERT INTO hg_duplicate_dn_po (batch_id, dn_number, po_number, part_number, reason) VALUES (?,?,?,?,?)`,
          [batchId, normCell(row[0]), normCell(row[1]), normCell(row[2]), normCell(row[3])]
        );
      }
    }
  }

  const rollupPath = path.join(batchAbsDir, 'output', 'summary_report.xlsx');
  if (fs.existsSync(rollupPath)) {
    const swb = XLSX.readFile(rollupPath);
    const ws = swb.Sheets.Summary || swb.Sheets.summary;
    if (ws) {
      const rows = sheetToAoA(ws);
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        await dbRun(
          `INSERT OR REPLACE INTO hg_po_matchrollup (batch_id, po_number, total_qty, matched_dn_count, rejected_dn_count)
           VALUES (?,?,?,?,?)`,
          [batchId, normCell(row[0]), numOrNull(row[1]), parseInt(row[2], 10) || 0, parseInt(row[3], 10) || 0]
        );
      }
    }
  }
}

async function importInputsFromPython(batchId, batchAbsDir) {
  const inputDir = path.join(batchAbsDir, 'input');
  const rulesPath = path.join(PLUGIN_ROOT, 'config', 'rules.json');
  const dumpScript = path.join(PLUGIN_ROOT, 'scripts', 'hg_dump_inputs_json.py');
  if (!fs.existsSync(dumpScript)) {
    console.warn('[huaweiGodamImporter] hg_dump_inputs_json.py missing, skipping input parse');
    return;
  }

  let stdout;
  try {
    const r = await execFile(PYTHON, [dumpScript, inputDir, rulesPath], {
      cwd: PLUGIN_ROOT,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PYTHONPATH: PLUGIN_ROOT },
    });
    stdout = r.stdout;
  } catch (e) {
    console.error('[huaweiGodamImporter] Python dump failed:', e.message, e.stderr?.toString());
    throw e;
  }

  let data;
  try {
    data = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`hg_dump_inputs_json invalid JSON: ${String(stdout).slice(0, 400)}`);
  }

  for (const c of data.contracts || []) {
    await dbRun(
      `INSERT OR IGNORE INTO hg_contract_row (batch_id, contract_no, project_name, customer_po_no, contract_version, reseller_name, end_customer_name)
       VALUES (?,?,?,?,?,?,?)`,
      [
        batchId,
        normCell(c.contractNo),
        normCell(c.projectName),
        normCell(c.customerPoNo),
        normCell(c.contractVersion),
        normCell(c.resellerName),
        normCell(c.endCustomerName),
      ]
    );
  }

  for (const p of data.po_lines || []) {
    await dbRun(
      `INSERT INTO hg_po_line (batch_id, po_number, po_item, material, open_qty, short_text, material_group, plant, storage_location)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        batchId,
        normCell(p.poNumber),
        normCell(p.poItem),
        normCell(p.material),
        p.openQty != null ? Number(p.openQty) : null,
        normCell(p.shortText),
        normCell(p.materialGroup),
        normCell(p.plant),
        normCell(p.storageLocation),
      ]
    );
  }

  for (const s of data.so_lines || []) {
    await dbRun(
      `INSERT INTO hg_so_line (batch_id, sales_document, customer_reference, sold_to_party, sold_to_name)
       VALUES (?,?,?,?,?)`,
      [
        batchId,
        normCell(s.salesDocument),
        normCell(s.customerReference),
        normCell(s.soldToParty),
        normCell(s.soldToName),
      ]
    );
  }

  for (const v of data.vcust_rows || []) {
    await dbRun(`INSERT OR IGNORE INTO hg_vcust_row (batch_id, customer_code, customer_name) VALUES (?,?,?)`, [
      batchId,
      normCell(v.customer_code),
      normCell(v.customer_name),
    ]);
  }

  for (const dn of data.dn_documents || []) {
    const poNums = Array.isArray(dn.poNumbers) ? dn.poNumbers : [];
    const poJson = JSON.stringify(poNums);
    const r = await new Promise((resolve, reject) => {
      hgDb.run(
        `INSERT INTO hg_dn_document (batch_id, original_filename, dn_number, contract_no, mr_no, customer_po_raw, so_number, po_numbers_json)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          batchId,
          normCell(dn.original_filename),
          normCell(dn.dnNumber),
          normCell(dn.contractNo),
          normCell(dn.mrNo),
          normCell(dn.customerPoRaw),
          normCell(dn.soNumber),
          poJson,
        ],
        function insertDnDoc(err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });

    const itemQty = dn.itemQty || {};
    const desc = dn.itemDescriptions || {};
    const serials = dn.itemSerials || {};
    for (const mat of Object.keys(itemQty)) {
      const sn = serials[mat];
      await dbRun(`INSERT INTO hg_dn_line (dn_document_id, material, qty, description, serials_json) VALUES (?,?,?,?,?)`, [
        r,
        normCell(mat),
        numOrNull(itemQty[mat]),
        normCell(desc[mat]),
        Array.isArray(sn) ? JSON.stringify(sn) : sn ? JSON.stringify(sn) : null,
      ]);
    }
  }
}

/**
 * After matcher succeeds: wipe prior rows for batch, import outputs + inputs + artifact pointers.
 */
async function importHuaweiGodamBatch(batchId, storageDirRelative) {
  const batchAbsDir = path.join(BACKEND_ROOT, storageDirRelative);
  await deleteBatchChildren(batchId);
  await importOutputsOnly(batchId, batchAbsDir);
  await importInputsFromPython(batchId, batchAbsDir);
  await importArtifacts(batchId, batchAbsDir);
}

async function importOutputsOnly(batchId, batchAbsDir) {
  await importOutputSheets(batchId, batchAbsDir);
}

module.exports = {
  importHuaweiGodamBatch,
  importOutputsOnly,
  deleteBatchChildren,
  PLUGIN_ROOT,
  PYTHON,
};
