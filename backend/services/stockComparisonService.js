const { promisify } = require('util');

const EPS = 1e-6;

function nearZero(n) {
  return Math.abs(Number(n) || 0) <= EPS;
}

/** Which storage_location values contribute to "SAP physical" for comparison */
function physicalSlSet(storageLocation) {
  const sl = String(storageLocation || '1004_1007').toLowerCase();
  if (sl === '1002') return new Set(['1002']);
  if (sl === '1004') return new Set(['1004']);
  if (sl === '1007') return new Set(['1007']);
  if (sl === '1004_1007' || sl === 'physical' || sl === '') return new Set(['1004', '1007']);
  if (sl === 'all') return new Set(['1002', '1004', '1007']);
  return new Set(['1004', '1007']);
}

function effQty(row) {
  const u = row.unrestricted_qty;
  if (u !== null && u !== undefined && String(u).trim() !== '') {
    const n = Number(u);
    if (Number.isFinite(n)) return n;
  }
  const s = Number(row.stock_qty);
  return Number.isFinite(s) ? s : 0;
}

function normSl(row) {
  const raw = String(row.storage_location ?? '').trim();
  return raw.replace(/^0+/, '') || raw;
}

function normalizeMaterialKey(m) {
  return String(m ?? '')
    .trim()
    .toLowerCase();
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

async function loadSapAggregates(db, batchId) {
  if (!batchId) {
    return {
      byMaterial: new Map(),
      materialsInUpload: new Set(),
      rows: [],
    };
  }
  const dbAll = promisify(db.all.bind(db));
  const rows = await dbAll(
    `SELECT material, storage_location, description, unrestricted_qty, stock_qty, material_group, vendor_number
     FROM sap_stock WHERE upload_batch_id = ?`,
    [batchId]
  );
  const byMaterial = new Map();
  const materialsInUpload = new Set();

  for (const r of rows || []) {
    const m = String(r.material ?? '').trim();
    if (!m) continue;
    const mk = normalizeMaterialKey(m);
    materialsInUpload.add(mk);
    const sl = normSl(r) || String(r.storage_location ?? '').trim();
    const q = effQty(r);
    if (!Number.isFinite(q)) continue;

    const cur = byMaterial.get(mk) || {
      q1002: 0,
      q1004: 0,
      q1007: 0,
      physical: 0,
      total: 0,
      description: '',
      material_group: '',
      vendor_number: '',
    };
    cur.total += q;
    if (sl === '1002') cur.q1002 += q;
    if (sl === '1004') cur.q1004 += q;
    if (sl === '1007') cur.q1007 += q;
    if (sl === '1004' || sl === '1007') cur.physical += q;
    if (String(r.description || '').length > String(cur.description || '').length) cur.description = r.description || '';
    if (r.material_group) cur.material_group = r.material_group;
    if (r.vendor_number) cur.vendor_number = r.vendor_number;
    byMaterial.set(mk, cur);
  }

  return { byMaterial, materialsInUpload, rows };
}

function sapPhysicalForFilter(agg, materialKey, storageLocation) {
  const a = agg.byMaterial.get(materialKey);
  if (!a) return { physical: 0, q1002: 0, q1004: 0, q1007: 0, total: 0 };
  const physSet = physicalSlSet(storageLocation);
  if (physSet.size === 1 && physSet.has('1002')) {
    return {
      physical: a.q1002,
      q1002: a.q1002,
      q1004: a.q1004,
      q1007: a.q1007,
      total: a.total,
    };
  }
  if (physSet.has('1004') && physSet.has('1007') && physSet.size === 2) {
    return {
      physical: a.q1004 + a.q1007,
      q1002: a.q1002,
      q1004: a.q1004,
      q1007: a.q1007,
      total: a.total,
    };
  }
  let physical = 0;
  if (physSet.has('1004')) physical += a.q1004;
  if (physSet.has('1007')) physical += a.q1007;
  if (physSet.has('1002')) physical += a.q1002;
  return {
    physical,
    q1002: a.q1002,
    q1004: a.q1004,
    q1007: a.q1007,
    total: a.total,
  };
}

function mainStockSapPhysicalTotals(agg, sapPart, partNum, storageLocation) {
  const s = String(sapPart ?? '').trim();
  const p = String(partNum ?? '').trim();
  const sk = normalizeMaterialKey(s);
  const pk = normalizeMaterialKey(p);
  let mk = null;
  if (s && agg.materialsInUpload.has(sk)) mk = sk;
  else if (s && !agg.materialsInUpload.has(sk) && p && agg.materialsInUpload.has(pk)) mk = pk;
  else if (!s && p && agg.materialsInUpload.has(pk)) mk = pk;

  if (!mk) {
    return { sap_physical_qty: 0, sap_transit_1002: 0, sap_qty_1004: 0, sap_qty_1007: 0 };
  }
  const t = sapPhysicalForFilter(agg, mk, storageLocation);
  const base = agg.byMaterial.get(mk) || { q1002: 0, q1004: 0, q1007: 0 };
  return {
    sap_physical_qty: t.physical,
    sap_transit_1002: base.q1002,
    sap_qty_1004: base.q1004,
    sap_qty_1007: base.q1007,
  };
}

function pickMainStockQtyForSapMaterial(agg, msList, materialKey) {
  for (const ms of msList) {
    const s = String(ms.sap_part_number ?? '').trim();
    if (s && normalizeMaterialKey(s) === materialKey) {
      return Number(ms.available_qty) || 0;
    }
  }
  for (const ms of msList) {
    const s = String(ms.sap_part_number ?? '').trim();
    const p = String(ms.part_number ?? '').trim();
    const sk = normalizeMaterialKey(s);
    const pk = normalizeMaterialKey(p);
    if (s && !agg.materialsInUpload.has(sk) && pk === materialKey) {
      return Number(ms.available_qty) || 0;
    }
  }
  for (const ms of msList) {
    const s = String(ms.sap_part_number ?? '').trim();
    const p = String(ms.part_number ?? '').trim();
    if (!s && normalizeMaterialKey(p) === materialKey) {
      return Number(ms.available_qty) || 0;
    }
  }
  return 0;
}

function passesRowFilters(st, diff, status) {
  const f = String(status || 'all').toLowerCase();
  if (f === 'all') return true;
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
  if (f === 'match' || f === 'match_only') return st === 'Match';
  if (f === 'mismatch' || f === 'mismatch_only') return st === 'Mismatch';
  if (f === 'missing_in_sap') return st === 'Missing in SAP';
  if (f === 'extra_in_sap') return st === 'Extra in SAP';
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
    row.sap_material,
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

function statusMainVsSap(mainAvail, sapPhysical, diff) {
  if (mainAvail > EPS && nearZero(sapPhysical)) return 'Missing in SAP';
  if (nearZero(mainAvail) && sapPhysical > EPS) return 'Extra in SAP';
  if (nearZero(diff)) return 'Match';
  return 'Mismatch';
}

function statusSapBase(mainQty, sapPhysical, diff) {
  if (sapPhysical > EPS && nearZero(mainQty)) return 'Extra in SAP';
  if (nearZero(diff)) return 'Match';
  return 'Mismatch';
}

function statusMainVsRack(mainAvail, rackAvail, diff) {
  if (nearZero(diff)) return 'Match';
  return 'Mismatch';
}

async function loadRackLines(db) {
  const dbAll = promisify(db.all.bind(db));
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

async function refreshMainStockSapQtyFromBatch(db, batchId) {
  const agg = await loadSapAggregates(db, batchId);
  const dbAll = promisify(db.all.bind(db));
  const dbRun = promisify(db.run.bind(db));
  const msRows = await dbAll(`SELECT id, part_number, sap_part_number FROM main_stock`);

  const mapPhysical = new Map();
  for (const [mk, v] of agg.byMaterial) {
    mapPhysical.set(mk, v.q1004 + v.q1007);
  }

  for (const ms of msRows) {
    const s = String(ms.sap_part_number ?? '').trim();
    const p = String(ms.part_number ?? '').trim();
    const sk = normalizeMaterialKey(s);
    const pk = normalizeMaterialKey(p);
    let qty = 0;
    if (s && agg.materialsInUpload.has(sk)) qty = mapPhysical.get(sk) || 0;
    else if (s && !agg.materialsInUpload.has(sk) && p && agg.materialsInUpload.has(pk)) qty = mapPhysical.get(pk) || 0;
    else if (!s && p && agg.materialsInUpload.has(pk)) qty = mapPhysical.get(pk) || 0;
    await dbRun(`UPDATE main_stock SET sap_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [qty, ms.id]);
  }
}

/**
 * @param {import('sqlite3').Database} db
 * @param {object} query
 */
async function getStockComparison(db, query) {
  const comparison_type = String(query.comparison_type || 'main_vs_sap').toLowerCase();
  const comparison_base = String(query.comparison_base || 'main_stock').toLowerCase();
  const storage_location = String(query.storage_location || '1004_1007').toLowerCase();
  const status = String(query.status || query.filter || 'all').toLowerCase();
  const search = String(query.search || '').trim();
  const search_part_number = String(query.search_part_number || query.part_number || '').trim();
  const search_sap_part_number = String(query.search_sap_part_number || query.sap_part_number || '').trim();
  const date_from = query.date_from ? String(query.date_from).trim() : '';
  const date_to = query.date_to ? String(query.date_to).trim() : '';

  const batchId = await resolveComparisonBatchId(db, { date_from, date_to });
  const agg = await loadSapAggregates(db, batchId);
  const dbAll = promisify(db.all.bind(db));
  const mainRows = await dbAll(
    `SELECT part_number, sap_part_number, description, available_qty, sap_qty, vendor_number
     FROM main_stock ORDER BY part_number`
  );
  const rackLines = await loadRackLines(db);
  const msList = mainRows;

  const rows = [];

  if (comparison_type === 'main_vs_rack') {
    for (const ms of msList) {
      const mainAvail = Number(ms.available_qty) || 0;
      const rackAvail = rackQtyForMain(ms, rackLines);
      const diff = mainAvail - rackAvail;
      const st = statusMainVsRack(mainAvail, rackAvail, diff);
      const row = {
        part_number: ms.part_number,
        sap_part_number: ms.sap_part_number,
        description: ms.description,
        main_stock_available_qty: mainAvail,
        stock_by_rack_available_qty: rackAvail,
        sap_qty: ms.sap_qty != null ? Number(ms.sap_qty) : null,
        difference: diff,
        status: st,
      };
      if (!searchHaystack(row, search)) continue;
      if (!matchesPartSapSearch(row, search_part_number, search_sap_part_number)) continue;
      if (!passesRowFilters(st, diff, status)) continue;
      rows.push(row);
    }
    return {
      rows,
      meta: {
        comparison_type: 'main_vs_rack',
        comparison_base,
        storage_location,
        batch_id: batchId,
        filter: status,
      },
    };
  }

  if (comparison_type === 'main_vs_sap' && comparison_base === 'main_stock') {
    for (const ms of msList) {
      const mainAvail = Number(ms.available_qty) || 0;
      const totals = mainStockSapPhysicalTotals(agg, ms.sap_part_number, ms.part_number, storage_location);
      const sapPhysical = totals.sap_physical_qty;
      const diff = mainAvail - sapPhysical;
      const st = statusMainVsSap(mainAvail, sapPhysical, diff);
      const row = {
        part_number: ms.part_number,
        sap_part_number: ms.sap_part_number,
        description: ms.description,
        vendor_number: ms.vendor_number,
        main_stock_available_qty: mainAvail,
        sap_physical_qty: sapPhysical,
        sap_transit_1002: totals.sap_transit_1002,
        sap_qty_1004: totals.sap_qty_1004,
        sap_qty_1007: totals.sap_qty_1007,
        difference: diff,
        status: st,
      };
      if (!searchHaystack(row, search)) continue;
      if (!matchesPartSapSearch(row, search_part_number, search_sap_part_number)) continue;
      if (!passesRowFilters(st, diff, status)) continue;
      rows.push(row);
    }
    return {
      rows,
      meta: {
        comparison_type: 'main_vs_sap',
        comparison_base: 'main_stock',
        storage_location,
        batch_id: batchId,
        filter: status,
      },
    };
  }

  if (comparison_type === 'main_vs_sap' && comparison_base === 'sap_stock') {
    const slFilter = String(storage_location || '1004_1007').toLowerCase();
    const matKeys = new Set();

    const includeSl = (sl) => {
      const n = normSl({ storage_location: sl });
      if (slFilter === 'all') return ['1002', '1004', '1007'].includes(n);
      if (slFilter === '1004_1007' || slFilter === '' || !slFilter) return n === '1004' || n === '1007';
      return n === slFilter;
    };

    for (const r of agg.rows || []) {
      const sl = normSl(r) || String(r.storage_location ?? '').trim();
      if (!includeSl(sl)) continue;
      const m = String(r.material ?? '').trim();
      if (!m) continue;
      matKeys.add(normalizeMaterialKey(m));
    }

    for (const mk of matKeys) {
      const t = sapPhysicalForFilter(agg, mk, storage_location);
      const sapPhysical = t.physical;
      const mainQty = pickMainStockQtyForSapMaterial(agg, msList, mk);
      const diff = mainQty - sapPhysical;
      const st = statusSapBase(mainQty, sapPhysical, diff);
      const info = agg.byMaterial.get(mk) || {};
      const sample = (agg.rows || []).find((x) => normalizeMaterialKey(x.material) === mk);
      const row = {
        sap_material: sample?.material ?? mk,
        description: info.description || sample?.description || '',
        sap_physical_qty: sapPhysical,
        main_stock_qty: mainQty,
        difference: diff,
        status: st,
        material_group: info.material_group || sample?.material_group || '',
        vendor_number: info.vendor_number || sample?.vendor_number || '',
      };

      if (!searchHaystack({ ...row, part_number: row.sap_material, sap_part_number: row.sap_material }, search)) {
        continue;
      }
      if (!matchesPartSapSearch({ part_number: row.sap_material, sap_part_number: row.sap_material }, search_part_number, search_sap_part_number)) {
        continue;
      }
      if (!passesRowFilters(st, diff, status)) continue;
      rows.push(row);
    }
    rows.sort((a, b) => String(a.sap_material).localeCompare(String(b.sap_material)));
    return {
      rows,
      meta: {
        comparison_type: 'main_vs_sap',
        comparison_base: 'sap_stock',
        storage_location,
        batch_id: batchId,
        filter: status,
      },
    };
  }

  return {
    rows: [],
    meta: {
      comparison_type,
      comparison_base,
      error: 'Unsupported comparison_type / comparison_base combination',
    },
  };
}

module.exports = {
  getStockComparison,
  resolveComparisonBatchId,
  loadSapAggregates,
  refreshMainStockSapQtyFromBatch,
};
