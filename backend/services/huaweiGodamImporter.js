const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const cp = require('child_process');
const { promisify } = require('util');

const hgDb = require('../huaweiGodamDb');
const { resolveGoDamPluginDir } = require('../godamPluginPaths');
const dbRun = promisify(hgDb.run.bind(hgDb));
const dbGet = promisify(hgDb.get.bind(hgDb));
const dbAll = promisify(hgDb.all.bind(hgDb));

const BACKEND_ROOT = path.join(__dirname, '..');
const REPO_ROOT = path.join(BACKEND_ROOT, '..');
/** Resolved GoDam-1.0 root (prefers plugins/GoDam-1.0). */
const PLUGIN_ROOT =
  resolveGoDamPluginDir(REPO_ROOT) || path.join(REPO_ROOT, 'plugins', 'GoDam-1.0');

/** Prefer plugins/GoDam-1.0/.venv (same as Streamlit script) so matcher CLI matches that env. */
function resolveHuaweiPython() {
  const explicit = process.env.HUAWEI_GODAM_PYTHON || process.env.GODAM_EXCEL_PYTHON;
  if (explicit) return explicit;
  const venvPy =
    process.platform === 'win32'
      ? path.join(PLUGIN_ROOT, '.venv', 'Scripts', 'python.exe')
      : path.join(PLUGIN_ROOT, '.venv', 'bin', 'python3');
  if (fs.existsSync(venvPy)) return venvPy;
  return 'python3';
}

const PYTHON = resolveHuaweiPython();

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

function splitDsaNumbers(raw) {
  const t = String(raw || '').trim();
  if (!t) return [];
  const parts = t
    .split(/[\r\n,;|]+/g)
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    // Sometimes the field is pasted with spaces; pull out DSA-like tokens.
    const m = p.match(/DSA\d+/gi);
    if (m && m.length) out.push(...m.map((x) => x.trim()));
    else out.push(p);
  }
  return Array.from(new Set(out)).filter(Boolean);
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

async function rebuildCustomerOrderTables() {
  // Current design keeps the latest imported snapshot for DN creation.
  await dbRun(`DELETE FROM huawei_delivery_item_details`);
  await dbRun(`DELETE FROM huawei_customer_order_header`);

  // Header rows are sourced from the generated "Summary" output sheet import (hg_summary_row).
  const hdrRows = await dbAll(
    `
      SELECT
        po,
        contract_no,
        contract_name,
        dn_number,
        distributor,
        remarks,
        number_of_boxes,
        batch_no,
        cbm
      FROM hg_summary_row
      ORDER BY id ASC
    `
  );

  // Contract rows provide end user + partner (reseller).
  const contractMap = new Map();
  const cRows = await dbAll(`SELECT contract_no, reseller_name, end_customer_name FROM hg_contract_row`);
  for (const c of cRows || []) {
    const k = String(c.contract_no || '').trim();
    if (!k) continue;
    contractMap.set(k, { reseller_name: c.reseller_name || null, end_customer_name: c.end_customer_name || null });
  }

  // DN docs provide customer PO + SO + file, and may include multiple POs.
  const dnDocs = await dbAll(
    `SELECT dn_number, contract_no, customer_po_raw, so_number, original_filename, po_numbers_json FROM hg_dn_document`
  );
  const dnDocMap = new Map(); // dn -> best doc
  for (const d of dnDocs || []) {
    const dn = String(d.dn_number || '').trim();
    if (!dn) continue;
    if (!dnDocMap.has(dn)) dnDocMap.set(dn, d);
  }

  // Build header rows; if bill_no_pl_no has multiple DSAs, create one row per DSA.
  const headerIdByPoDsa = new Map();
  for (const r of hdrRows || []) {
    const po = normCell(r.po);
    if (!po) continue;
    const contractNo = normCell(r.contract_no);
    const dist = normCell(r.distributor);
    const remarks = normCell(r.remarks);
    const billRaw = normCell(r.dn_number);
    const dsaList = splitDsaNumbers(billRaw);
    const cx = contractNo ? contractMap.get(contractNo) : null;
    const dnDoc = billRaw ? dnDocMap.get(String(billRaw).trim()) : null;

    const base = {
      gapp_po_number: po,
      customer_po_number: dnDoc?.customer_po_raw ? String(dnDoc.customer_po_raw) : null,
      partner_name: cx?.reseller_name || dist || null,
      end_user: cx?.end_customer_name || null,
      contract_no: contractNo,
      note: remarks,
      no_of_box: numOrNull(r.number_of_boxes),
      bill_no_pl_no: billRaw,
      location: null,
      received_date: null,
      batch_amount: null,
      gr_number: null,
      inventory_age: null,
      status: 'Received',
      delivered_date: null,
      invoice_no: null,
      invoice_amount: null,
      psi_status: null,
    };

    const list = dsaList.length ? dsaList : billRaw ? [billRaw] : [];
    for (const dsa of list) {
      const dsaNum = String(dsa || '').trim() || null;
      await dbRun(
        `INSERT INTO huawei_customer_order_header
          (gapp_po_number, customer_po_number, partner_name, end_user, contract_no, note, no_of_box,
           bill_no_pl_no, dsa_number, location, received_date, batch_amount, gr_number, inventory_age, status,
           delivered_date, invoice_no, invoice_amount, psi_status, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`,
        [
          base.gapp_po_number,
          base.customer_po_number,
          base.partner_name,
          base.end_user,
          base.contract_no,
          base.note,
          base.no_of_box,
          base.bill_no_pl_no,
          dsaNum,
          base.location,
          base.received_date,
          base.batch_amount,
          base.gr_number,
          base.inventory_age,
          base.status,
          base.delivered_date,
          base.invoice_no,
          base.invoice_amount,
          base.psi_status,
        ]
      );
      const row = await dbGet(`SELECT last_insert_rowid() AS id`);
      const hid = row?.id ? Number(row.id) : null;
      if (hid && base.gapp_po_number && dsaNum) headerIdByPoDsa.set(`${base.gapp_po_number}::${dsaNum}`, hid);
    }
  }

  // Item-level rows: from DN documents + DN lines (material rows).
  const lines = await dbAll(
    `
      SELECT
        d.dn_number,
        d.contract_no,
        d.customer_po_raw,
        d.so_number,
        d.original_filename,
        d.po_numbers_json,
        l.material,
        l.qty,
        l.description
      FROM hg_dn_document d
      JOIN hg_dn_line l ON l.dn_document_id = d.id
      ORDER BY d.id ASC, l.id ASC
    `
  );

  for (const it of lines || []) {
    const dsa = normCell(it.dn_number);
    if (!dsa) continue;

    let po = null;
    try {
      const arr = it.po_numbers_json ? JSON.parse(String(it.po_numbers_json)) : [];
      po = Array.isArray(arr) && arr.length ? String(arr[0] || '').trim() : null;
    } catch {
      po = null;
    }

    const contractNo = normCell(it.contract_no);
    const cx = contractNo ? contractMap.get(contractNo) : null;
    const headerId = po && dsa ? headerIdByPoDsa.get(`${po}::${dsa}`) : null;

    await dbRun(
      `INSERT INTO huawei_delivery_item_details
        (header_id, gapp_po_number, customer_po_number, dsa_number, contract_no, so_number, partner_name, end_user,
         batch, part_number, description, quantity, uom, volume, cbm, status, source_file, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, CURRENT_TIMESTAMP)`,
      [
        headerId || null,
        po,
        it.customer_po_raw ? String(it.customer_po_raw) : null,
        dsa,
        contractNo,
        normCell(it.so_number),
        cx?.reseller_name || null,
        cx?.end_customer_name || null,
        null,
        normCell(it.material),
        normCell(it.description),
        numOrNull(it.qty),
        null,
        null,
        null,
        'Received',
        normCell(it.original_filename),
      ]
    );
  }
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
  await rebuildCustomerOrderTables();
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
