const { promisify } = require('util');
const { normalizeSapStorageLoc, KNOWN_SL } = require('../utils/sapStorageLoc');

const EPS = 1e-6;

function nearZero(n) {
  return Math.abs(Number(n) || 0) <= EPS;
}

const SL_ALL = ['1001', '1002', '1003', '1004', '1005', '1007'];

/** Which storage_location values contribute to SAP qty for the selected filter */
function physicalSlSet(storageLocation) {
  const sl = String(storageLocation || '1004_1007').toLowerCase().replace(/\s+/g, '');
  const singles = {
    1001: new Set(['1001']),
    1002: new Set(['1002']),
    1003: new Set(['1003']),
    1004: new Set(['1004']),
    1005: new Set(['1005']),
    1007: new Set(['1007']),
  };
  if (singles[sl]) return singles[sl];
  if (sl === '1004_1007' || sl === 'physical' || sl === '') return new Set(['1004', '1007']);
  if (sl === 'multi_sl' || sl === '1002_1005_1001_1003_1004_1007' || sl === 'all_sl') return new Set(SL_ALL);
  if (sl === 'all' || sl === 'legacy_all') return new Set(['1002', '1004', '1007']);
  return new Set(['1004', '1007']);
}

/** Multi-select SL (comma/semicolon); falls back to legacy storage_location preset when empty/invalid. */
function resolvePhysicalSlSet(query) {
  const rawList = query.storage_locs ?? query.storageLocs;
  if (rawList != null && String(rawList).trim() !== '') {
    const set = new Set();
    for (const part of String(rawList).split(/[,;]+/)) {
      const code = normalizeSapStorageLoc(part.trim());
      if (code && KNOWN_SL.has(code)) set.add(code);
    }
    if (set.size > 0) {
      const sorted = [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      return { slSet: set, storage_locs: sorted, storage_location_label: sorted.join(',') };
    }
  }
  const storage_location = String(query.storage_location || '1004_1007').toLowerCase();
  const slSet = physicalSlSet(storage_location);
  const sorted = [...slSet].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { slSet, storage_locs: sorted, storage_location_label: storage_location };
}

function parseSapNumericQty(v) {
  if (v === null || v === undefined || String(v).trim() === '') return undefined;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : undefined;
}

function effQty(row) {
  const u = parseSapNumericQty(row.unrestricted_qty);
  if (u !== undefined) return u;
  const s = parseSapNumericQty(row.stock_qty);
  return s !== undefined ? s : 0;
}

function normSl(row) {
  return normalizeSapStorageLoc(row.storage_location);
}

function normalizeMaterialKey(m) {
  let s = String(m ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  s = s.replace(/\u2011|\u2010|\u2013|\u2212/g, '-');
  return s.toLowerCase();
}

/** Find aggregated SAP bucket key for main-stock part/SAP fields (hyphen-insensitive). */
function resolveAggMaterialKey(agg, sapPart, partNum) {
  const candidates = [];
  const add = (raw) => {
    const t = String(raw ?? '').trim();
    if (!t) return;
    const k = normalizeMaterialKey(t);
    candidates.push(k);
    if (k.includes('-')) candidates.push(k.replace(/-/g, ''));
  };
  add(sapPart);
  add(partNum);
  for (const k of candidates) {
    if (!k) continue;
    const cur = agg.byMaterial.get(k);
    if (cur) return cur.primaryMaterialKey || k;
  }
  return null;
}

/** Align main_stock.vendor_number with sap_stock.material_group text (e.g. "1103 DCUMS Comscope" → "1103"). */
function vendorMaterialGroupKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const head = s.match(/^(\d{3,})/);
  if (head) return head[1];
  const inner = s.match(/\b(\d{3,})\b/);
  if (inner) return inner[1];
  return s.split(/\s+/)[0].toLowerCase();
}

/** Main vs SAP or main vs rack: OK both zero or equal; Excess main higher; Less main lower. */
function qtyBalanceRemark(mainQty, compareQty) {
  const m = Number(mainQty) || 0;
  const c = Number(compareQty) || 0;
  if (nearZero(m) && nearZero(c)) return 'OK';
  if (nearZero(m - c)) return 'OK';
  if (m > c + EPS) return 'Excess';
  return 'Less';
}

async function resolveComparisonBatchId(db, { date_from, date_to }) {
  const dbGet = promisify(db.get.bind(db));
  let sql = `
    SELECT id FROM sap_stock_upload_batches
    WHERE status = 'Processed'
  `;
  const params = [];
  if (date_from) {
    sql += ` AND date(upload_date) >= date(?)`;
    params.push(String(date_from).trim());
  }
  if (date_to) {
    sql += ` AND date(upload_date) <= date(?)`;
    params.push(String(date_to).trim());
  }
  sql += ` ORDER BY id DESC LIMIT 1`;
  const row = await dbGet(sql, params);
  return row?.id ?? null;
}

async function loadSapAggregates(db, batchId, opts = {}) {
  const vendorKeysRaw = []
    .concat(opts.vendorScopeKeys || [])
    .map((k) => String(k ?? '').trim())
    .filter(Boolean);
  const legacyKey = opts.vendorScopeKey ? String(opts.vendorScopeKey).trim() : '';
  const vendorScopeKeys = vendorKeysRaw.length ? [...new Set(vendorKeysRaw)] : legacyKey ? [legacyKey] : [];
  const materialAllowlist = opts.materialKeysAllowlist;
  const useAllowlist =
    vendorScopeKeys.length > 0 &&
    materialAllowlist &&
    typeof materialAllowlist.has === 'function' &&
    materialAllowlist.size > 0;
  if (!batchId) {
    return {
      byMaterial: new Map(),
      materialsInUpload: new Set(),
      rows: [],
    };
  }
  const dbAll = promisify(db.all.bind(db));
  const rowsRaw = await dbAll(
    `SELECT material, storage_location, description, unrestricted_qty, stock_qty, material_group, vendor_number
     FROM sap_stock WHERE upload_batch_id = ?`,
    [batchId]
  );
  const rows = [];
  for (const r of rowsRaw || []) {
    if (vendorScopeKeys.length > 0) {
      const mgk = vendorMaterialGroupKey(r.material_group);
      const svk = vendorMaterialGroupKey(r.vendor_number);
      const vendorMatch = vendorScopeKeys.some((vk) => mgk === vk || svk === vk);
      const mkRow = normalizeMaterialKey(String(r.material ?? '').trim());
      const rowKeys = [mkRow];
      if (mkRow.includes('-')) rowKeys.push(mkRow.replace(/-/g, ''));
      const materialMatch =
        useAllowlist && rowKeys.some((k) => k && materialAllowlist.has(k));
      if (!vendorMatch && !materialMatch) continue;
    }
    rows.push(r);
  }
  const byMaterial = new Map();
  const materialsInUpload = new Set();

  for (const r of rows || []) {
    const m = String(r.material ?? '').trim();
    if (!m) continue;
    const mk = normalizeMaterialKey(m);
    materialsInUpload.add(mk);
    if (mk.includes('-')) materialsInUpload.add(mk.replace(/-/g, ''));
    const sl = normSl(r) || normalizeSapStorageLoc(String(r.storage_location ?? '').trim());
    const q = effQty(r);
    if (!Number.isFinite(q)) continue;

    const alt = mk.includes('-') ? mk.replace(/-/g, '') : '';
    let cur = byMaterial.get(mk);
    if (!cur && alt) cur = byMaterial.get(alt);
    if (!cur) {
      cur = {
        primaryMaterialKey: mk,
        q1001: 0,
        q1002: 0,
        q1003: 0,
        q1004: 0,
        q1005: 0,
        q1007: 0,
        total: 0,
        description: '',
        material_group: '',
        vendor_number: '',
      };
      byMaterial.set(mk, cur);
      if (alt) byMaterial.set(alt, cur);
    }
    if (!cur.primaryMaterialKey) cur.primaryMaterialKey = mk;
    else if (mk.includes('-') && !String(cur.primaryMaterialKey).includes('-')) {
      cur.primaryMaterialKey = mk;
    }
    byMaterial.set(mk, cur);
    if (mk.includes('-')) {
      const comp = mk.replace(/-/g, '');
      if (comp) byMaterial.set(comp, cur);
    }
    cur.total += q;
    if (sl === '1001') cur.q1001 += q;
    else if (sl === '1002') cur.q1002 += q;
    else if (sl === '1003') cur.q1003 += q;
    else if (sl === '1004') cur.q1004 += q;
    else if (sl === '1005') cur.q1005 += q;
    else if (sl === '1007') cur.q1007 += q;
    if (String(r.description || '').length > String(cur.description || '').length) cur.description = r.description || '';
    if (r.material_group) cur.material_group = r.material_group;
    if (r.vendor_number) cur.vendor_number = r.vendor_number;
    byMaterial.set(mk, cur);
  }

  return { byMaterial, materialsInUpload, rows };
}

function sapPhysicalForFilter(agg, materialKey, slSet) {
  const a = agg.byMaterial.get(materialKey);
  const empty = {
    physical: 0,
    q1001: 0,
    q1002: 0,
    q1003: 0,
    q1004: 0,
    q1005: 0,
    q1007: 0,
    total: 0,
  };
  if (!a) return empty;
  const physSet = slSet instanceof Set ? slSet : physicalSlSet(slSet);
  let physical = 0;
  for (const code of physSet) {
    const bucket = `q${code}`;
    physical += Number(a[bucket]) || 0;
  }
  return {
    physical,
    q1001: a.q1001,
    q1002: a.q1002,
    q1003: a.q1003,
    q1004: a.q1004,
    q1005: a.q1005,
    q1007: a.q1007,
    total: a.total,
  };
}

function mainStockSapPhysicalTotals(agg, sapPart, partNum, slSet) {
  const mk = resolveAggMaterialKey(agg, sapPart, partNum);

  if (!mk) {
    return {
      sap_physical_qty: 0,
      sap_transit_1002: 0,
      sap_qty_1003: 0,
      sap_qty_1004: 0,
      sap_qty_1007: 0,
      sap_qty_1001: 0,
      sap_qty_1005: 0,
    };
  }
  const t = sapPhysicalForFilter(agg, mk, slSet);
  const base = agg.byMaterial.get(mk) || {
    q1001: 0,
    q1002: 0,
    q1003: 0,
    q1004: 0,
    q1005: 0,
    q1007: 0,
  };
  return {
    sap_physical_qty: t.physical,
    sap_transit_1002: base.q1002,
    sap_qty_1003: base.q1003,
    sap_qty_1004: base.q1004,
    sap_qty_1007: base.q1007,
    sap_qty_1001: base.q1001,
    sap_qty_1005: base.q1005,
  };
}

function pickMainStockQtyForSapMaterial(agg, msList, materialKeyFromSap) {
  const target = resolveAggMaterialKey(agg, materialKeyFromSap, '');
  if (!target) return 0;
  let sum = 0;
  for (const ms of msList) {
    const rk = resolveAggMaterialKey(agg, ms.sap_part_number, ms.part_number);
    if (rk === target) sum += Number(ms.available_qty) || 0;
  }
  return sum;
}

function passesRowFilters(row, status) {
  const f = String(status || 'all').toLowerCase();
  if (f === 'all') return true;
  const diff =
    row.difference != null && row.difference !== ''
      ? Number(row.difference)
      : Number(row.main_vs_sap_difference) || 0;
  const mainQ = Number(row.main_stock_available_qty ?? row.main_stock_qty ?? 0) || 0;
  const sapQ = Number(row.sap_physical_qty ?? 0) || 0;
  const comparison_result = row.comparison_result ?? row.status;
  const sap_balance = row.sap_balance;
  const rack_balance = row.rack_balance;
  const diffFilters = new Set([
    'diff_gt_0',
    'difference_gt_0',
    'diff_lt_0',
    'difference_lt_0',
    'diff_eq_0',
    'difference_eq_0',
  ]);
  if (diffFilters.has(f)) {
    const d = Number(diff) || 0;
    if (f === 'diff_gt_0' || f === 'difference_gt_0') return d > EPS;
    if (f === 'diff_lt_0' || f === 'difference_lt_0') return d < -EPS;
    if (f === 'diff_eq_0' || f === 'difference_eq_0') return nearZero(d);
    return true;
  }
  if (f === 'match' || f === 'match_only' || f === 'matching_only') return comparison_result === 'Matching';
  if (f === 'mismatch' || f === 'mismatch_only' || f === 'mismatching_only') return comparison_result === 'Mismatching';
  if (f === 'sap_excess') return sap_balance != null && sap_balance === 'Excess';
  if (f === 'sap_less') return sap_balance != null && sap_balance === 'Less';
  if (f === 'rack_excess') return rack_balance != null && rack_balance === 'Excess';
  if (f === 'rack_less') return rack_balance != null && rack_balance === 'Less';
  if (f === 'missing_in_sap') return mainQ > EPS && nearZero(sapQ);
  if (f === 'extra_in_sap') return nearZero(mainQ) && sapQ > EPS;
  if (f === 'mismatch_rack' || f === 'mismatch_rack_only') return rack_balance != null && rack_balance !== 'OK';
  if (f === 'mismatch_sap' || f === 'mismatch_sap_only') return sap_balance != null && sap_balance !== 'OK';
  return true;
}

function searchHaystack(row, needle) {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const fields = [
    row.part_number,
    row.sap_part_number,
    row.description,
    row.material_group,
    row.vendor_number,
    row.vendor_name,
    row.sap_material,
    row.sap_lookup_material,
  ];
  return fields.some((f) => String(f || '').toLowerCase().includes(n));
}

function matchesPartSapSearch(row, searchPn, searchSap) {
  const pn = String(searchPn || '').trim().toLowerCase();
  const sp = String(searchSap || '').trim().toLowerCase();
  if (pn && !String(row.part_number || '').toLowerCase().includes(pn)) return false;
  if (sp && !String(row.sap_part_number || '').toLowerCase().includes(sp)) return false;
  return true;
}

async function loadRackLines(db, whId) {
  const dbAll = promisify(db.all.bind(db));
  if (whId != null && Number(whId) > 0) {
    return dbAll(
      `SELECT part_number, sap_part_number, available_qty FROM stock_by_rack WHERE warehouse_id = ?`,
      [Number(whId)]
    );
  }
  return dbAll(`SELECT part_number, sap_part_number, available_qty FROM stock_by_rack`);
}

function rackQtyForMain(ms, rackLines) {
  const pn = String(ms.part_number ?? '').trim();
  const sp = String(ms.sap_part_number ?? '').trim();
  let s = 0;
  for (const L of rackLines || []) {
    const lpn = String(L.part_number ?? '').trim();
    const lsp = String(L.sap_part_number ?? '').trim();
    const q = Number(L.available_qty) || 0;
    if (lpn === pn || (sp && lsp === sp)) s += q;
  }
  return s;
}

/** SAP upload material # used for lookup (blank if no batch match). */
function resolveSapLookupMaterial(agg, sapPart, partNum) {
  const mkRes = resolveAggMaterialKey(agg, sapPart, partNum);
  if (!mkRes) return '';
  const sample = (agg.rows || []).find((x) => resolveAggMaterialKey(agg, x.material, '') === mkRes);
  return sample?.material != null ? String(sample.material).trim() : '';
}

function passesUnifiedFilters(row, status) {
  const f = String(status || 'all').toLowerCase();
  if (f === 'all') return true;
  const dSap = Number(row.main_vs_sap_difference) || 0;
  const dRack = Number(row.main_vs_rack_difference) || 0;
  const mainQ = Number(row.main_stock_available_qty) || 0;
  const sapQ = Number(row.sap_physical_qty) || 0;
  const diffFilters = new Set([
    'diff_gt_0',
    'difference_gt_0',
    'diff_lt_0',
    'difference_lt_0',
    'diff_eq_0',
    'difference_eq_0',
  ]);
  if (diffFilters.has(f)) {
    if (f === 'diff_gt_0' || f === 'difference_gt_0') return dSap > EPS || dRack > EPS;
    if (f === 'diff_lt_0' || f === 'difference_lt_0') return dSap < -EPS || dRack < -EPS;
    if (f === 'diff_eq_0' || f === 'difference_eq_0') return nearZero(dSap) && nearZero(dRack);
    return true;
  }
  if (f === 'match' || f === 'match_only' || f === 'matching_only') return row.comparison_result === 'Matching';
  if (f === 'mismatch' || f === 'mismatch_only' || f === 'mismatching_only') return row.comparison_result === 'Mismatching';
  if (f === 'sap_excess') return row.sap_balance === 'Excess';
  if (f === 'sap_less') return row.sap_balance === 'Less';
  if (f === 'rack_excess') return row.rack_balance === 'Excess';
  if (f === 'rack_less') return row.rack_balance === 'Less';
  if (f === 'missing_in_sap') return mainQ > EPS && nearZero(sapQ);
  if (f === 'extra_in_sap') return nearZero(mainQ) && sapQ > EPS;
  if (f === 'mismatch_rack' || f === 'mismatch_rack_only') return row.rack_balance !== 'OK';
  if (f === 'mismatch_sap' || f === 'mismatch_sap_only') return row.sap_balance !== 'OK';
  return true;
}

async function refreshMainStockSapQtyFromBatch(db, batchId) {
  const agg = await loadSapAggregates(db, batchId, {});
  const dbAll = promisify(db.all.bind(db));
  const dbRun = promisify(db.run.bind(db));
  const msRows = await dbAll(`SELECT id, part_number, sap_part_number FROM main_stock`);

  const mapPhysical = new Map();
  const seenBucket = new Set();
  for (const [, v] of agg.byMaterial) {
    const pk = v.primaryMaterialKey;
    if (!pk || seenBucket.has(pk)) continue;
    seenBucket.add(pk);
    mapPhysical.set(pk, (Number(v.q1004) || 0) + (Number(v.q1007) || 0));
  }

  for (const ms of msRows) {
    const rk = resolveAggMaterialKey(agg, ms.sap_part_number, ms.part_number);
    const qty = rk ? mapPhysical.get(rk) || 0 : 0;
    await dbRun(`UPDATE main_stock SET sap_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [qty, ms.id]);
  }
}

function buildVendorChoicesFromMainRows(mainRows) {
  const byScope = new Map();
  for (const ms of mainRows || []) {
    const rawVn = String(ms.vendor_number || '').trim();
    if (!rawVn) continue;
    const scope = vendorMaterialGroupKey(rawVn) || rawVn.toLowerCase();
    if (byScope.has(scope)) continue;
    byScope.set(scope, {
      vendor_scope_key: scope,
      vendor_number: scope,
      vendor_number_display: rawVn,
      vendor_name: String(ms.vendor_name || '').trim(),
    });
  }
  const out = Array.from(byScope.values());
  out.sort((a, b) =>
    a.vendor_scope_key.localeCompare(b.vendor_scope_key, undefined, { numeric: true })
  );
  return out;
}

function matchesVendorScope(ms, vendorScopeKey) {
  if (!vendorScopeKey) return true;
  const vk = vendorMaterialGroupKey(ms.vendor_number);
  return vk === vendorScopeKey;
}

/** Normalized material keys from main rows — used to keep SAP upload lines for those parts even when SAP MG/vendor text does not match the vendor scope key. */
function materialKeysFromMainStock(msRows) {
  const keys = new Set();
  const add = (raw) => {
    const t = String(raw ?? '').trim();
    if (!t) return;
    const k = normalizeMaterialKey(t);
    keys.add(k);
    if (k.includes('-')) keys.add(k.replace(/-/g, ''));
  };
  for (const ms of msRows || []) {
    add(ms.sap_part_number);
    add(ms.part_number);
  }
  return keys;
}

/**
 * @param {import('sqlite3').Database} db
 * @param {object} query
 */
async function getStockComparison(db, query) {
  const comparison_type = String(query.comparison_type || 'main_vs_sap').toLowerCase();
  const comparison_base = String(query.comparison_base || 'main_stock').toLowerCase();
  const { slSet, storage_locs, storage_location_label } = resolvePhysicalSlSet(query);
  const status = String(query.status || query.filter || 'all').toLowerCase();
  const search = String(query.search || '').trim();
  const search_part_number = String(query.search_part_number || query.part_number || '').trim();
  const search_sap_part_number = String(query.search_sap_part_number || query.sap_part_number || '').trim();
  const date_from = query.date_from ? String(query.date_from).trim() : '';
  const date_to = query.date_to ? String(query.date_to).trim() : '';

  const warehouseFilterRaw =
    query.warehouse_id != null && query.warehouse_id !== '' ? String(query.warehouse_id).trim().toLowerCase() : '';
  const whId =
    warehouseFilterRaw && warehouseFilterRaw !== 'all' && Number(query.warehouse_id) > 0
      ? Number(query.warehouse_id)
      : null;

  const batchId = await resolveComparisonBatchId(db, { date_from, date_to });
  const vendorMultiRaw = String(query.vendor_numbers || query.vendor_ids || '').trim();
  const vendorRaw = String(query.vendor_number || '').trim();
  let vendor_scope_keys = [];
  if (vendorMultiRaw && vendorMultiRaw.toLowerCase() !== 'all') {
    vendor_scope_keys = vendorMultiRaw
      .split(/[,;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => vendorMaterialGroupKey(s) || s);
  } else if (vendorRaw && vendorRaw.toLowerCase() !== 'all') {
    vendor_scope_keys = [vendorMaterialGroupKey(vendorRaw) || vendorRaw];
  }
  vendor_scope_keys = [...new Set(vendor_scope_keys.map((k) => String(k || '').trim()).filter(Boolean))];
  const vendor_filter_raw =
    vendorMultiRaw && vendorMultiRaw.toLowerCase() !== 'all'
      ? vendorMultiRaw
      : vendorRaw && vendorRaw.toLowerCase() !== 'all'
        ? vendorRaw
        : '';
  const dbAll = promisify(db.all.bind(db));
  const msParams = [];
  let msSql = `SELECT part_number, sap_part_number, description, available_qty, sap_qty, vendor_number, vendor_name
     FROM main_stock WHERE 1=1`;
  if (whId) {
    msSql += ` AND warehouse_id = ?`;
    msParams.push(whId);
  }
  msSql += ` ORDER BY part_number`;
  const mainRowsAll = await dbAll(msSql, msParams);
  const available_vendors = buildVendorChoicesFromMainRows(mainRowsAll);
  const msList =
    vendor_scope_keys.length > 0
      ? mainRowsAll.filter((ms) => vendor_scope_keys.some((vk) => matchesVendorScope(ms, vk)))
      : mainRowsAll;
  const sapMaterialAllowlist = vendor_scope_keys.length ? materialKeysFromMainStock(msList) : null;
  const agg = await loadSapAggregates(db, batchId, {
    vendorScopeKeys: vendor_scope_keys,
    materialKeysAllowlist: sapMaterialAllowlist,
  });

  const rackLines = await loadRackLines(db, whId);

  const attachMeta = (partial) => ({
    ...partial,
    available_vendors,
    vendor_filter: vendor_scope_keys.length ? vendor_scope_keys.join(',') : null,
    vendor_filters: vendor_scope_keys.length ? vendor_scope_keys : null,
    vendor_filter_display: vendor_filter_raw || null,
    storage_locs,
    storage_location: storage_location_label,
    comparison_note:
      'Vendor filter picks main rows by vendor key (e.g. 1103). SAP rows included when material_group/vendor matches that key, or when SAP material matches any filtered main part/SAP part (so unrestricted qty still compares if SAP line vendor codes differ). Quantities prefer unrestricted_qty then stock_qty; SL filter applies to summed buckets.',
  });

  const rows = [];

  if (comparison_type === 'main_unified' || comparison_type === 'main_vs_all') {
    for (const ms of msList) {
      const mainAvail = Number(ms.available_qty) || 0;
      const totals = mainStockSapPhysicalTotals(agg, ms.sap_part_number, ms.part_number, slSet);
      const sapPhysical = totals.sap_physical_qty;
      const diffSap = mainAvail - sapPhysical;
      const rackAvail = rackQtyForMain(ms, rackLines);
      const diffRack = mainAvail - rackAvail;
      const sap_balance = qtyBalanceRemark(mainAvail, sapPhysical);
      const rack_balance = qtyBalanceRemark(mainAvail, rackAvail);
      const comparison_result =
        nearZero(diffSap) && nearZero(diffRack) ? 'Matching' : 'Mismatching';
      const sapLookupMaterial = resolveSapLookupMaterial(agg, ms.sap_part_number, ms.part_number);
      const row = {
        part_number: ms.part_number,
        sap_part_number: ms.sap_part_number,
        sap_lookup_material: sapLookupMaterial,
        description: ms.description,
        vendor_number: ms.vendor_number,
        vendor_name: ms.vendor_name,
        main_stock_available_qty: mainAvail,
        sap_qty_on_main: ms.sap_qty != null ? Number(ms.sap_qty) : null,
        sap_physical_qty: sapPhysical,
        sap_transit_1002: totals.sap_transit_1002,
        sap_qty_1003: totals.sap_qty_1003,
        sap_qty_1004: totals.sap_qty_1004,
        sap_qty_1007: totals.sap_qty_1007,
        main_vs_sap_difference: diffSap,
        sap_balance,
        stock_by_rack_available_qty: rackAvail,
        main_vs_rack_difference: diffRack,
        rack_balance,
        comparison_result,
        status: comparison_result,
      };
      if (!searchHaystack(row, search)) continue;
      if (!matchesPartSapSearch(row, search_part_number, search_sap_part_number)) continue;
      if (!passesUnifiedFilters(row, status)) continue;
      rows.push(row);
    }
    return {
      rows,
      meta: attachMeta({
        comparison_type: 'main_unified',
        comparison_base: 'main_stock',
        batch_id: batchId,
        filter: status,
        note:
          'One row per main stock item. With vendor filter: SAP rows restricted to same material_group/vendor key (e.g. 1103). SAP qty uses selected SL filter; rack sums stock_by_rack by part/SAP part.',
      }),
    };
  }

  if (comparison_type === 'main_vs_rack') {
    for (const ms of msList) {
      const mainAvail = Number(ms.available_qty) || 0;
      const rackAvail = rackQtyForMain(ms, rackLines);
      const diff = mainAvail - rackAvail;
      const balance = qtyBalanceRemark(mainAvail, rackAvail);
      const comparison_result = nearZero(diff) ? 'Matching' : 'Mismatching';
      const row = {
        part_number: ms.part_number,
        sap_part_number: ms.sap_part_number,
        description: ms.description,
        vendor_number: ms.vendor_number,
        vendor_name: ms.vendor_name,
        main_stock_available_qty: mainAvail,
        stock_by_rack_available_qty: rackAvail,
        sap_qty: ms.sap_qty != null ? Number(ms.sap_qty) : null,
        difference: diff,
        rack_balance: balance,
        comparison_result,
        status: comparison_result,
      };
      if (!searchHaystack(row, search)) continue;
      if (!matchesPartSapSearch(row, search_part_number, search_sap_part_number)) continue;
      if (!passesRowFilters(row, status)) continue;
      rows.push(row);
    }
    return {
      rows,
      meta: attachMeta({
        comparison_type: 'main_vs_rack',
        comparison_base,
        batch_id: batchId,
        filter: status,
      }),
    };
  }

  if (comparison_type === 'main_vs_sap' && comparison_base === 'main_stock') {
    for (const ms of msList) {
      const mainAvail = Number(ms.available_qty) || 0;
      const totals = mainStockSapPhysicalTotals(agg, ms.sap_part_number, ms.part_number, slSet);
      const sapPhysical = totals.sap_physical_qty;
      const diff = mainAvail - sapPhysical;
      const sap_balance = qtyBalanceRemark(mainAvail, sapPhysical);
      const comparison_result = nearZero(diff) ? 'Matching' : 'Mismatching';
      const row = {
        part_number: ms.part_number,
        sap_part_number: ms.sap_part_number,
        description: ms.description,
        vendor_number: ms.vendor_number,
        vendor_name: ms.vendor_name,
        main_stock_available_qty: mainAvail,
        sap_physical_qty: sapPhysical,
        sap_transit_1002: totals.sap_transit_1002,
        sap_qty_1003: totals.sap_qty_1003,
        sap_qty_1004: totals.sap_qty_1004,
        sap_qty_1007: totals.sap_qty_1007,
        difference: diff,
        sap_balance,
        comparison_result,
        status: comparison_result,
      };
      if (!searchHaystack(row, search)) continue;
      if (!matchesPartSapSearch(row, search_part_number, search_sap_part_number)) continue;
      if (!passesRowFilters(row, status)) continue;
      rows.push(row);
    }
    return {
      rows,
      meta: attachMeta({
        comparison_type: 'main_vs_sap',
        comparison_base: 'main_stock',
        batch_id: batchId,
        filter: status,
      }),
    };
  }

  if (comparison_type === 'main_vs_sap' && comparison_base === 'sap_stock') {
    const matKeys = new Set();
    const allowedSl = slSet;

    for (const r of agg.rows || []) {
      const sl = normSl(r) || normalizeSapStorageLoc(String(r.storage_location ?? '').trim());
      if (!allowedSl.has(sl)) continue;
      const m = String(r.material ?? '').trim();
      if (!m) continue;
      matKeys.add(normalizeMaterialKey(m));
    }

    const bucketKeys = new Set();
    for (const mkRaw of matKeys) {
      const bk = resolveAggMaterialKey(agg, mkRaw, '');
      if (bk) bucketKeys.add(bk);
    }

    for (const mk of bucketKeys) {
      const t = sapPhysicalForFilter(agg, mk, slSet);
      const sapPhysical = t.physical;
      const mainQty = pickMainStockQtyForSapMaterial(agg, msList, mk);
      const diff = mainQty - sapPhysical;
      const sap_balance = qtyBalanceRemark(mainQty, sapPhysical);
      const comparison_result = nearZero(diff) ? 'Matching' : 'Mismatching';
      const info = agg.byMaterial.get(mk) || {};
      const sample = (agg.rows || []).find((x) => resolveAggMaterialKey(agg, x.material, '') === mk);
      const row = {
        sap_material: sample?.material ?? mk,
        description: info.description || sample?.description || '',
        sap_physical_qty: sapPhysical,
        main_stock_qty: mainQty,
        difference: diff,
        sap_balance,
        comparison_result,
        status: comparison_result,
        material_group: info.material_group || sample?.material_group || '',
        vendor_number: info.vendor_number || sample?.vendor_number || '',
      };

      if (!searchHaystack({ ...row, part_number: row.sap_material, sap_part_number: row.sap_material }, search)) {
        continue;
      }
      if (!matchesPartSapSearch({ part_number: row.sap_material, sap_part_number: row.sap_material }, search_part_number, search_sap_part_number)) {
        continue;
      }
      if (!passesRowFilters(row, status)) continue;
      rows.push(row);
    }
    rows.sort((a, b) => String(a.sap_material).localeCompare(String(b.sap_material)));
    return {
      rows,
      meta: attachMeta({
        comparison_type: 'main_vs_sap',
        comparison_base: 'sap_stock',
        batch_id: batchId,
        filter: status,
      }),
    };
  }

  return {
    rows: [],
    meta: attachMeta({
      comparison_type,
      comparison_base,
      error: 'Unsupported comparison_type / comparison_base combination',
    }),
  };
}

module.exports = {
  getStockComparison,
  resolveComparisonBatchId,
  loadSapAggregates,
  refreshMainStockSapQtyFromBatch,
};
