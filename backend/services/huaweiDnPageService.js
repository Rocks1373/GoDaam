/**
 * Huawei delivery notes — packing list lines (huawei_dn_lines), RECEIVED orders only.
 */
const { promisify } = require('util');
const db = require('../db');
const { runDb } = require('../utils/dbRun');
const { changeOrderStatus } = require('./huaweiOrderService');
const { DATA_TIER_PERMANENT, lockOrderAsPermanent } = require('./huaweiDataLifecycle');
const {
  normPo,
  normStatus: normDnStatus,
  isEffectivelyReceivedOrder,
  sqlEffectivelyReceivedOrder,
  groupItemsByBox,
} = require('./huaweiDnPageHelpers');

const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));
const dbRun = promisify(db.run.bind(db));

const RECEIVED_ORDER_STATUS = 'RECEIVED';
const BLOCKED_ORDER_STATUSES = ['UPCOMING', 'MATCHING', 'MATCHED', 'CONFIRMED', 'CHECKING', 'GR_DONE', 'DN_CREATED', 'DELIVERED'];

const normStatus = normDnStatus;
let dnItemColumnsCache = null;

async function getHuaweiDnItemColumns() {
  if (dnItemColumnsCache) return dnItemColumnsCache;
  try {
    const pgRows = await dbAll(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'huawei_delivery_note_items'`
    );
    if (Array.isArray(pgRows) && pgRows.length) {
      dnItemColumnsCache = new Set(pgRows.map((r) => String(r.column_name || '').trim()).filter(Boolean));
      return dnItemColumnsCache;
    }
  } catch {
    // not postgres, try sqlite pragma
  }
  const sqRows = await dbAll(`PRAGMA table_info('huawei_delivery_note_items')`);
  dnItemColumnsCache = new Set(sqRows.map((r) => String(r.name || '').trim()).filter(Boolean));
  return dnItemColumnsCache;
}

function orderClauseForDnItems(cols) {
  return cols.has('box_name') ? 'ORDER BY box_name, id' : 'ORDER BY id';
}

/** Fix orders that were received but status reset to PENDING_CONFIRMATION (INPUT refresh). */
async function repairStuckReceivedOrdersOnPo(po, warehouseId) {
  const p = normPo(po);
  if (!p) return { repaired: 0 };
  const params = [p, p];
  let sql = `
    SELECT o.id, o.dsa_number, o.batch_dsa, o.status
    FROM huawei_orders o
    WHERE (
      UPPER(TRIM(COALESCE(o.sap_po, ''))) = ?
      OR UPPER(TRIM(COALESCE(o.customer_po_number, o.customer_po, ''))) = ?
    )
      AND UPPER(TRIM(o.status)) = 'PENDING_CONFIRMATION'
      AND o.received_at IS NOT NULL
      AND TRIM(COALESCE(o.gr_number, '')) != ''`;
  if (warehouseId != null) {
    sql += ` AND (o.warehouse_id = ? OR o.warehouse_id IS NULL)`;
    params.push(Number(warehouseId));
  }
  const stuck = await dbAll(sql, params);
  for (const o of stuck) {
    await dbRun(
      `UPDATE huawei_orders SET
        status = 'RECEIVED',
        received_status = 'RECEIVED',
        confirmation_status = COALESCE(confirmation_status, 'CONFIRMED'),
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [o.id]
    );
  }
  return { repaired: stuck.length, dsas: stuck.map((o) => o.dsa_number || o.batch_dsa) };
}

/** RECEIVED orders with packing lines still on staging/confirmed — promote to permanent for DN. */
async function ensurePermanentPackingLinesOnPo(po, warehouseId) {
  const p = normPo(po);
  if (!p) return { fixed: 0 };
  const eff = sqlEffectivelyReceivedOrder('o');
  const params = [p, p];
  let sql = `
    SELECT o.id, o.dsa_number, o.batch_dsa, o.status
    FROM huawei_orders o
    WHERE (
      UPPER(TRIM(COALESCE(o.sap_po, ''))) = ?
      OR UPPER(TRIM(COALESCE(o.customer_po_number, o.customer_po, ''))) = ?
    )
      AND ${eff}`;
  if (warehouseId != null) {
    sql += ` AND (o.warehouse_id = ? OR o.warehouse_id IS NULL)`;
    params.push(Number(warehouseId));
  }
  const orders = await dbAll(sql, params);
  let fixed = 0;
  for (const o of orders) {
    const tiers = await dbGet(
      `SELECT COUNT(1) AS c FROM huawei_dn_lines
       WHERE huawei_order_id = ? AND COALESCE(data_tier, 'staging') = ?`,
      [o.id, DATA_TIER_PERMANENT]
    );
    if (Number(tiers?.c) > 0) continue;
    const hasLines = await dbGet(
      `SELECT COUNT(1) AS c FROM huawei_dn_lines WHERE huawei_order_id = ?`,
      [o.id]
    );
    if (!Number(hasLines?.c)) continue;
    await lockOrderAsPermanent(o.id);
    fixed += 1;
  }
  return { fixed, dsas: orders.map((x) => x.dsa_number || x.batch_dsa) };
}

function poMatchSql(aliasOrder = 'o', aliasLine = 'ln') {
  return `(
    UPPER(TRIM(COALESCE(${aliasLine}.sap_po, ${aliasOrder}.sap_po, ''))) = ?
    OR UPPER(TRIM(COALESCE(${aliasOrder}.customer_po_number, ${aliasOrder}.customer_po, ''))) = ?
  )`;
}

async function nextDnNumber() {
  const row = await dbGet(`SELECT dn_number FROM huawei_delivery_notes ORDER BY id DESC LIMIT 1`);
  const last = row?.dn_number || '';
  const m = String(last).match(/(\d+)\s*$/);
  const n = m ? Number(m[1]) + 1 : 1;
  return `HW-DN-${String(n).padStart(5, '0')}`;
}

function mapPackingLineRow(ln) {
  return {
    dn_line_id: ln.id,
    huawei_order_id: ln.huawei_order_id,
    dsa_number: ln.order_dsa_number || ln.dsa_number || ln.order_batch_dsa || null,
    sap_po: ln.sap_po || ln.order_sap_po || null,
    customer_po_number: ln.order_customer_po_number || ln.order_customer_po || null,
    sap_so: ln.sap_so || ln.order_sap_so || null,
    part_number: ln.part_number,
    description: ln.description,
    qty: ln.qty,
    quantity: ln.qty,
    uom: ln.uom,
    box_name: ln.box_name || null,
    box_number: ln.box_name || null,
    weight_kg: ln.weight_kg ?? null,
    volume_cbm: ln.volume_cbm ?? null,
    location: ln.item_location || null,
    order_status: ln.order_status,
    received_status: ln.item_received_status || RECEIVED_ORDER_STATUS,
    reseller_name: ln.order_reseller_name || null,
    customer_name: ln.order_customer_name || null,
    contract_number: ln.order_contract_number || null,
    huawei_contract: ln.order_huawei_contract || null,
  };
}

function normalizeDnGroupMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  return m === 'part' ? 'part' : 'box';
}

function aggregateLinesByPart(items) {
  const map = new Map();
  for (const it of items || []) {
    const key = String(it.part_number || '').trim().toUpperCase();
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        ...it,
        qty: Number(it.qty ?? it.quantity) || 0,
        quantity: Number(it.qty ?? it.quantity) || 0,
        weight_kg: Number(it.weight_kg) || 0,
        volume_cbm: Number(it.volume_cbm) || 0,
      });
    } else {
      const ex = map.get(key);
      ex.qty += Number(it.qty ?? it.quantity) || 0;
      ex.quantity = ex.qty;
      ex.weight_kg += Number(it.weight_kg) || 0;
      ex.volume_cbm += Number(it.volume_cbm) || 0;
      ex.box_name = null;
    }
  }
  const rows = [...map.values()].sort((a, b) =>
    String(a.part_number || '').localeCompare(String(b.part_number || ''), undefined, { numeric: true })
  );
  return rows.map((r, i) => ({
    ...r,
    box_name: String(i + 1),
    box_number: String(i + 1),
  }));
}

function prepareDnLinesForMode(items, groupMode) {
  const mode = normalizeDnGroupMode(groupMode);
  const prepared = mode === 'part' ? aggregateLinesByPart(items) : (items || []);
  const total_volume_cbm = prepared.reduce((s, r) => s + (Number(r.volume_cbm) || 0), 0);
  const total_weight_kg = prepared.reduce((s, r) => s + (Number(r.weight_kg) || 0), 0);
  return { mode, items: prepared, total_volume_cbm, total_weight_kg };
}

function parseMaybeNumber(v) {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

/**
 * Orders on this PO that are not RECEIVED (cannot be included in Huawei DN).
 */
async function findNonReceivedOrdersOnPo(po, warehouseId) {
  const p = normPo(po);
  if (!p) return [];
  const eff = sqlEffectivelyReceivedOrder('o');
  const params = [p, p];
  let sql = `
    SELECT o.id, o.dsa_number, o.batch_dsa, o.status, o.received_status
    FROM huawei_orders o
    WHERE (
      UPPER(TRIM(COALESCE(o.sap_po, ''))) = ?
      OR UPPER(TRIM(COALESCE(o.customer_po_number, o.customer_po, ''))) = ?
    )
      AND NOT ${eff}`;
  if (warehouseId != null) {
    sql += ` AND (o.warehouse_id = ? OR o.warehouse_id IS NULL)`;
    params.push(Number(warehouseId));
  }
  sql += ` ORDER BY o.dsa_number, o.id`;
  return dbAll(sql, params);
}

/**
 * On RECEIVED orders for this PO, packing-list lines whose item received_status is not RECEIVED.
 */
async function findNonReceivedItemsOnPo(po, warehouseId) {
  const p = normPo(po);
  if (!p) return [];
  const eff = sqlEffectivelyReceivedOrder('o');
  const params = [p, p];
  let sql = `
    SELECT DISTINCT
      o.dsa_number,
      o.id AS huawei_order_id,
      it.part_number,
      COALESCE(it.received_status, '') AS received_status,
      COALESCE(it.order_status, '') AS order_status
    FROM huawei_order_items it
    INNER JOIN huawei_orders o ON o.id = it.huawei_order_id
    WHERE (
      UPPER(TRIM(COALESCE(o.sap_po, ''))) = ?
      OR UPPER(TRIM(COALESCE(o.customer_po_number, o.customer_po, ''))) = ?
    )
      AND ${eff}
      AND COALESCE(it.data_tier, 'staging') IN ('confirmed', 'permanent')
      AND UPPER(TRIM(COALESCE(it.received_status, ''))) NOT IN ('RECEIVED', '')
      AND UPPER(TRIM(COALESCE(it.order_status, ''))) NOT IN ('RECEIVED', 'GR_DONE', 'DN_CREATED')`;
  if (warehouseId != null) {
    sql += ` AND (o.warehouse_id = ? OR o.warehouse_id IS NULL)`;
    params.push(Number(warehouseId));
  }
  sql += ` ORDER BY o.dsa_number, it.part_number LIMIT 50`;
  return dbAll(sql, params);
}

async function fetchReceivedPackingLines({ sapPo = null, customerPo = null, dsaNumbers = [], warehouseId = null } = {}) {
  const po = normPo(sapPo || customerPo);
  const dsas = [...new Set((dsaNumbers || []).map((d) => String(d).trim().toUpperCase()).filter(Boolean))];
  const eff = sqlEffectivelyReceivedOrder('o');
  const params = [];
  let sql = `
    SELECT ln.*,
      o.dsa_number AS order_dsa_number,
      o.batch_dsa AS order_batch_dsa,
      o.sap_po AS order_sap_po,
      o.sap_so AS order_sap_so,
      o.contract_number AS order_contract_number,
      o.huawei_contract AS order_huawei_contract,
      o.customer_po_number AS order_customer_po_number,
      o.customer_po AS order_customer_po,
      o.reseller_name AS order_reseller_name,
      o.customer_name AS order_customer_name,
      o.status AS order_status,
      o.received_status AS order_received_status,
      (
        SELECT it.location FROM huawei_order_items it
        WHERE it.huawei_order_id = ln.huawei_order_id
          AND UPPER(TRIM(COALESCE(it.part_number, ''))) = UPPER(TRIM(COALESCE(ln.part_number, '')))
          AND COALESCE(it.data_tier, 'staging') IN ('confirmed', 'permanent')
        ORDER BY it.id DESC LIMIT 1
      ) AS item_location,
      (
        SELECT it.received_status FROM huawei_order_items it
        WHERE it.huawei_order_id = ln.huawei_order_id
          AND UPPER(TRIM(COALESCE(it.part_number, ''))) = UPPER(TRIM(COALESCE(ln.part_number, '')))
          AND COALESCE(it.data_tier, 'staging') IN ('confirmed', 'permanent')
        ORDER BY it.id DESC LIMIT 1
      ) AS item_received_status
    FROM huawei_dn_lines ln
    INNER JOIN huawei_orders o ON o.id = ln.huawei_order_id
    WHERE ${eff}
      AND COALESCE(ln.data_tier, 'staging') = CASE
        WHEN UPPER(TRIM(o.status)) IN ('RECEIVED', 'DN_CREATED', 'DELIVERED') THEN 'permanent'
        WHEN UPPER(TRIM(o.status)) = 'CONFIRMED' THEN 'confirmed'
        ELSE 'staging'
      END`;

  if (warehouseId != null) {
    sql += ` AND (o.warehouse_id = ? OR o.warehouse_id IS NULL)`;
    params.push(Number(warehouseId));
  }
  if (po) {
    sql += ` AND ${poMatchSql('o', 'ln')}`;
    params.push(po, po);
  }
  if (dsas.length) {
    const ph = dsas.map(() => '?').join(',');
    sql += ` AND UPPER(TRIM(COALESCE(o.dsa_number, o.batch_dsa, ''))) IN (${ph})`;
    params.push(...dsas);
  }
  if (!po && !dsas.length) {
    return [];
  }
  sql += ` ORDER BY ln.box_name, o.batch_dsa, ln.part_number, ln.line_no, ln.id`;
  const rows = await dbAll(sql, params);
  if (rows.length) return rows.map(mapPackingLineRow);

  // Primary fallback: try loading directly from staging huawei_dn_lines if available (box-wise, detailed)
  if (po) {
    const dl = await dbAll(
      `SELECT ln.*,
         o.dsa_number AS order_dsa_number,
         o.batch_dsa AS order_batch_dsa,
         o.sap_po AS order_sap_po,
         o.sap_so AS order_sap_so,
         o.contract_number AS order_contract_number,
         o.huawei_contract AS order_huawei_contract,
         o.customer_po_number AS order_customer_po_number,
         o.customer_po AS order_customer_po,
         o.reseller_name AS order_reseller_name,
         o.customer_name AS order_customer_name,
         o.status AS order_status
       FROM huawei_dn_lines ln
       INNER JOIN huawei_orders o ON o.id = ln.huawei_order_id
       WHERE UPPER(TRIM(COALESCE(ln.sap_po, ''))) = ?
       ORDER BY ln.box_name, o.batch_dsa, ln.part_number, ln.line_no, ln.id`,
      [po]
    );
    if (dl && dl.length > 0) {
      return dl.map(mapPackingLineRow);
    }
  }

  // Fallback: if source packing lines were already consumed into Huawei DN items (DN_CREATED),
  // allow creating regular DN from latest created Huawei DN rows.
  if (po || dsas.length) {
    const fbParams = [];
    let whereSql = [];
    if (po) {
      whereSql.push(`UPPER(TRIM(COALESCE(di.sap_po, ''))) = ?`);
      fbParams.push(po);
    }
    if (dsas.length) {
      whereSql.push(`UPPER(TRIM(COALESCE(di.dsa_number, ''))) IN (${dsas.map(() => '?').join(',')})`);
      fbParams.push(...dsas);
    }
    const where = whereSql.length ? `WHERE ${whereSql.join(' OR ')}` : '';
    const latest = await dbGet(
      `SELECT MAX(di.huawei_dn_id) AS huawei_dn_id
       FROM huawei_delivery_note_items di
       ${where}`,
      fbParams
    );
    const dnId = Number(latest?.huawei_dn_id);
    if (Number.isFinite(dnId) && dnId > 0) {
      const fromDn = await dbAll(
        `SELECT di.*, h.status AS dn_status
         FROM huawei_delivery_note_items di
         LEFT JOIN huawei_delivery_notes h ON h.id = di.huawei_dn_id
         WHERE di.huawei_dn_id = ?
         ORDER BY di.id ASC`,
        [dnId]
      );

      // Fetch order metadata (customer_name, reseller_name, contract, SO number)
      let orderInfo = null;
      if (po) {
        orderInfo = await dbGet(
          `SELECT customer_name, reseller_name, contract_number, huawei_contract, sap_so 
           FROM huawei_orders 
           WHERE UPPER(TRIM(sap_po)) = ? ORDER BY id DESC LIMIT 1`,
          [po]
        );
      } else if (dsas.length) {
        orderInfo = await dbGet(
          `SELECT customer_name, reseller_name, contract_number, huawei_contract, sap_so 
           FROM huawei_orders 
           WHERE UPPER(TRIM(dsa_number)) IN (${dsas.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`,
          dsas
        );
      }

      // Load original box names and weights/volumes from staging DN lines to restore box-wise grouping and details
      const partBoxes = new Map();
      const partLineWeights = new Map();
      if (po) {
        const dl = await dbAll(
          `SELECT part_number, box_name, weight_kg, volume_cbm 
           FROM huawei_dn_lines 
           WHERE UPPER(TRIM(COALESCE(sap_po, ''))) = ?`,
          [po]
        );
        for (const row of dl || []) {
          const key = String(row.part_number || '').trim().toUpperCase();
          if (row.box_name && String(row.box_name).trim() !== '') {
            if (!partBoxes.has(key)) partBoxes.set(key, []);
            partBoxes.get(key).push(row.box_name);
          }
          if (row.weight_kg != null || row.volume_cbm != null) {
            if (!partLineWeights.has(key)) partLineWeights.set(key, []);
            partLineWeights.get(key).push({
              w: Number(row.weight_kg) || 0,
              v: Number(row.volume_cbm) || 0
            });
          }
        }
      }

      const partWeights = new Map();
      if (po) {
        const oi = await dbAll(
          `SELECT part_number, gross_weight, gross_cbm
           FROM huawei_order_items
           WHERE UPPER(TRIM(COALESCE(sap_po, ''))) = ?`,
          [po]
        );
        for (const r of oi || []) {
          const key = String(r.part_number || '').trim().toUpperCase();
          if (!key) continue;
          if (!partWeights.has(key)) {
            partWeights.set(key, { w: 0, v: 0 });
          }
          const x = partWeights.get(key);
          x.w += parseMaybeNumber(r.gross_weight);
          x.v += parseMaybeNumber(r.gross_cbm);
        }
      }

      const partBoxesUsed = new Map();
      const partLineWeightsUsed = new Map();
      return (fromDn || []).map((r) => {
        const key = String(r.part_number || '').trim().toUpperCase();
        let box = r.box_name || null;
        if (!box && partBoxes.has(key)) {
          const boxes = partBoxes.get(key);
          const usedIndex = partBoxesUsed.get(key) || 0;
          if (usedIndex < boxes.length) {
            box = boxes[usedIndex];
            partBoxesUsed.set(key, usedIndex + 1);
          }
        }

        let lineW = null;
        let lineV = null;
        if (partLineWeights.has(key)) {
          const wvs = partLineWeights.get(key);
          const usedIdx = partLineWeightsUsed.get(key) || 0;
          if (usedIdx < wvs.length) {
            lineW = wvs[usedIdx].w;
            lineV = wvs[usedIdx].v;
            partLineWeightsUsed.set(key, usedIdx + 1);
          }
        }

        return {
          dn_line_id: null,
          huawei_order_id: null,
          dsa_number: r.dsa_number || null,
          sap_po: r.sap_po || null,
          customer_po_number: orderInfo?.customer_po_number || orderInfo?.customer_po || null,
          part_number: r.part_number,
          description: r.description,
          qty: Number(r.quantity) || 0,
          quantity: Number(r.quantity) || 0,
          uom: r.uom || 'PCS',
          box_name: box || null,
          box_number: box || null,
          weight_kg:
            r.weight_kg != null
              ? Number(r.weight_kg)
              : (lineW != null ? lineW : (partWeights.get(key)?.w || null)),
          volume_cbm:
            r.volume_cbm != null
              ? Number(r.volume_cbm)
              : (lineV != null ? lineV : (partWeights.get(key)?.v || null)),
          location: r.location || null,
          order_status: 'RECEIVED',
          received_status: RECEIVED_ORDER_STATUS,
          reseller_name: orderInfo?.reseller_name || null,
          customer_name: orderInfo?.customer_name || null,
          contract_number: orderInfo?.contract_number || null,
          huawei_contract: orderInfo?.huawei_contract || null,
          sap_so: orderInfo?.sap_so || null,
        };
      });
    }
  }

  return [];
}

async function summarizeOrdersForLines(items) {
  const byOrder = new Map();
  for (const it of items || []) {
    const key = it.huawei_order_id;
    if (!byOrder.has(key)) {
      byOrder.set(key, {
        huawei_order_id: key,
        dsa_number: it.dsa_number,
        status: it.order_status,
        received_status: it.received_status,
        line_count: 0,
        box_names: new Set(),
      });
    }
    const o = byOrder.get(key);
    o.line_count += 1;
    if (it.box_name) o.box_names.add(it.box_name);
  }
  return [...byOrder.values()].map((o) => ({
    ...o,
    unique_box_count: o.box_names.size,
    box_names: undefined,
  }));
}

async function validatePoForHuaweiDn(po, warehouseId) {
  const p = normPo(po);
  const errors = [];
  const warnings = [];
  if (!p) {
    return { valid: false, errors: ['PO number is required'], warnings, po_number: '' };
  }

  const repair = await repairStuckReceivedOrdersOnPo(p, warehouseId);
  if (repair.repaired > 0) {
    warnings.push(
      `Repaired ${repair.repaired} order(s) stuck as PENDING_CONFIRMATION after GR/receive: ${repair.dsas.join(', ')}`
    );
  }

  const tierFix = await ensurePermanentPackingLinesOnPo(p, warehouseId);
  if (tierFix.fixed > 0) {
    warnings.push(
      `Promoted packing lines to permanent for ${tierFix.fixed} received order(s): ${tierFix.dsas.filter(Boolean).join(', ')}`
    );
  }

  const items = await fetchReceivedPackingLines({ sapPo: p, warehouseId });

  const blockedOrders = await findNonReceivedOrdersOnPo(p, warehouseId);
  for (const o of blockedOrders) {
    const st = normStatus(o.status);
    const msg = `DSA ${o.dsa_number || o.batch_dsa || o.id}: order status is ${st} — skipped (not received yet).`;
    if (items.length > 0) {
      warnings.push(msg);
    } else {
      errors.push(
        `${msg} No other RECEIVED order on this PO has packing lines to include.`
      );
    }
  }

  const badItems = await findNonReceivedItemsOnPo(p, warehouseId);
  for (const it of badItems.slice(0, 10)) {
    const msg = `DSA ${it.dsa_number}: part ${it.part_number} is not RECEIVED (item status: ${it.received_status || it.order_status || 'pending'}).`;
    if (items.length > 0) warnings.push(msg);
    else errors.push(msg);
  }
  if (badItems.length > 10) {
    const tail = `…and ${badItems.length - 10} more item(s) not in RECEIVED status.`;
    if (items.length > 0) warnings.push(tail);
    else errors.push(tail);
  }

  if (!items.length && !errors.length) {
    errors.push(`No RECEIVED packing-list lines found for PO ${p}.`);
  }
  if (!items.length && blockedOrders.length && !errors.some((e) => e.includes('No other RECEIVED'))) {
    errors.push(
      `PO ${p} has ${blockedOrders.length} order(s) not in RECEIVED status and no received lines to ship. Mark received or use a single RECEIVED DSA.`
    );
  }

  const orders = await summarizeOrdersForLines(items);
  for (const o of orders) {
    if (!isEffectivelyReceivedOrder({ status: o.status, received_status: o.received_status })) {
      errors.push(`DSA ${o.dsa_number}: summary status must be RECEIVED.`);
    }
  }

  return {
    valid: errors.length === 0 && items.length > 0,
    errors,
    warnings,
    po_number: p,
    items,
    boxes: groupItemsByBox(items),
    orders,
    item_count: items.length,
    blocked_order_count: blockedOrders.length,
    blocked_statuses: BLOCKED_ORDER_STATUSES,
  };
}

async function previewHuaweiDeliveryNote(opts = {}) {
  const po = normPo(opts.sap_po || opts.customer_po || opts.po_number);
  const dsas = String(opts.dsa_numbers || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (po) {
    const base = await validatePoForHuaweiDn(po, opts.warehouseId);
    const prepared = prepareDnLinesForMode(base.items || [], opts.group_mode);
    return {
      ...base,
      group_mode: prepared.mode,
      items: prepared.items,
      boxes: groupItemsByBox(prepared.items),
      item_count: prepared.items.length,
      total_volume_cbm: prepared.total_volume_cbm,
      total_weight_kg: prepared.total_weight_kg,
    };
  }
  if (dsas.length) {
    const items = await fetchReceivedPackingLines({
      dsaNumbers: dsas,
      warehouseId: opts.warehouseId,
    });
    if (!items.length) {
      return {
        valid: false,
        errors: ['No RECEIVED packing-list lines found for the given DSA number(s).'],
        warnings: [],
        items: [],
        boxes: [],
        orders: [],
        item_count: 0,
      };
    }
    const nonReceived = items.filter((r) => !isEffectivelyReceivedOrder({ status: r.order_status }));
    const errors = [];
    const warnings = [];
    if (nonReceived.length) {
      warnings.push(
        `${nonReceived.length} line(s) from non-received orders were excluded.`
      );
    }
    const receivedOnly = items.filter((r) => isEffectivelyReceivedOrder({ status: r.order_status }));
    if (!receivedOnly.length) {
      errors.push('No RECEIVED packing-list lines found for the given DSA number(s).');
    }
    const prepared = prepareDnLinesForMode(receivedOnly, opts.group_mode);
    return {
      valid: receivedOnly.length > 0 && !errors.length,
      errors,
      warnings,
      group_mode: prepared.mode,
      items: prepared.items,
      boxes: groupItemsByBox(prepared.items),
      orders: await summarizeOrdersForLines(receivedOnly),
      item_count: prepared.items.length,
      total_volume_cbm: prepared.total_volume_cbm,
      total_weight_kg: prepared.total_weight_kg,
    };
  }
  return {
    valid: false,
    errors: ['Enter a PO number or DSA number(s).'],
    warnings: [],
    items: [],
    boxes: [],
    orders: [],
    item_count: 0,
  };
}

/** @deprecated alias */
async function fetchReceivedItems(opts) {
  return fetchReceivedPackingLines(opts);
}

async function createHuaweiDeliveryNote({ dsa_numbers = [], sap_po = null, group_mode = 'box', userId, warehouseId = null } = {}) {
  const po = normPo(sap_po);
  const dsas = [...new Set((dsa_numbers || []).map((d) => String(d).trim()).filter(Boolean))];

  let items = [];
  if (po) {
    const check = await validatePoForHuaweiDn(po, warehouseId);
    if (!check.valid) {
      const err = new Error(check.errors[0] || 'PO is not eligible for delivery note');
      err.statusCode = 400;
      err.details = check.errors;
      throw err;
    }
    items = check.items;
  } else if (dsas.length) {
    items = await fetchReceivedPackingLines({ dsaNumbers: dsas, warehouseId });
    if (!items.length) {
      throw Object.assign(new Error('No RECEIVED packing-list lines found for the given DSA number(s)'), {
        statusCode: 400,
      });
    }
    items = items.filter((r) => isEffectivelyReceivedOrder({ status: r.order_status }));
    if (!items.length) {
      throw Object.assign(
        new Error('Delivery note can only include RECEIVED orders — complete receive for this DSA first.'),
        { statusCode: 400 }
      );
    }
  } else {
    throw Object.assign(new Error('Provide SAP PO or DSA number(s)'), { statusCode: 400 });
  }

  const prepared = prepareDnLinesForMode(items, group_mode);
  const dnItems = prepared.items;

  const reseller =
    items.find((r) => r.reseller_name)?.reseller_name ||
    items.find((r) => r.customer_name)?.customer_name ||
    null;
  const customer_name = reseller || items[0]?.customer_name || 'Huawei Customer';
  const dn_number = await nextDnNumber();
  const sourceDsa = [...new Set(items.map((r) => r.dsa_number).filter(Boolean))].join(', ');
  const sourceSap = po || items[0]?.sap_po || null;
  const contractNo = items.find((r) => r.huawei_contract || r.contract_number)?.huawei_contract
    || items.find((r) => r.contract_number)?.contract_number
    || null;
  const created_from = dsas.length > 1 ? 'multi_dsa' : dsas.length === 1 ? 'dsa' : 'sap_po';

  const { lastID: huaweiDnId } = await runDb(
    db,
    `INSERT INTO huawei_delivery_notes (
      dn_number, customer_name, reseller_name, created_from, source_dsa_numbers, source_sap_po, contract_number,
      status, created_by, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, CURRENT_TIMESTAMP)`,
    [dn_number, customer_name, reseller, created_from, sourceDsa, sourceSap, contractNo, userId || null]
  );

  const dnItemCols = await getHuaweiDnItemColumns();
  for (const it of dnItems) {
    const rowData = {
      huawei_dn_id: huaweiDnId,
      dsa_number: it.dsa_number,
      sap_po: it.sap_po,
      part_number: it.part_number,
      description: it.description,
      quantity: it.qty ?? it.quantity,
      uom: it.uom,
      location: it.location,
      box_name: it.box_name,
      weight_kg: it.weight_kg,
      volume_cbm: it.volume_cbm,
      huawei_dn_line_id: it.dn_line_id || null,
    };
    const insertCols = Object.keys(rowData).filter((c) => dnItemCols.has(c));
    const placeholders = insertCols.map(() => '?').join(', ');
    const values = insertCols.map((c) => rowData[c]);
    await dbRun(
      `INSERT INTO huawei_delivery_note_items (
        ${insertCols.join(', ')}, created_at
      ) VALUES (${placeholders}, CURRENT_TIMESTAMP)`,
      values
    );
  }

  const orderIds = [...new Set(items.map((r) => r.huawei_order_id).filter(Boolean))];
  for (const oid of orderIds) {
    await dbRun(
      `UPDATE huawei_order_items SET order_status = 'DN_CREATED', updated_at = CURRENT_TIMESTAMP
       WHERE huawei_order_id = ? AND COALESCE(data_tier, 'staging') = ?`,
      [oid, DATA_TIER_PERMANENT]
    );
    await changeOrderStatus(oid, 'DN_CREATED', {
      userId,
      remarks: `Huawei DN ${dn_number}`,
      forceFromList: true,
      canChangeStatus: true,
    });
  }

  const lines = await dbAll(`SELECT * FROM huawei_delivery_note_items WHERE huawei_dn_id = ? ${orderClauseForDnItems(dnItemCols)}`, [huaweiDnId]);

  let gapp_delivery_note = null;
  if (sourceSap) {
    try {
      const { syncGappDeliveryNoteFromHuaweiPo } = require('./huaweiDnGappSyncService');
      gapp_delivery_note = await syncGappDeliveryNoteFromHuaweiPo({
        sap_po: sourceSap,
        warehouseId,
        userId,
        rebuild: true,
        rawLines: items,
      });
    } catch (e) {
      console.warn('[huaweiDn] GAPP delivery note sync:', e.message);
    }
  }

  return {
    id: huaweiDnId,
    dn_number,
    customer_name,
    reseller_name: reseller,
    source_dsa_numbers: sourceDsa,
    source_sap_po: sourceSap,
    contract_number: contractNo,
    group_mode: prepared.mode,
    total_volume_cbm: prepared.total_volume_cbm,
    total_weight_kg: prepared.total_weight_kg,
    item_count: lines.length,
    boxes: groupItemsByBox(lines.map((r) => ({ ...r, box_name: r.box_name, qty: r.quantity }))),
    items: lines,
    gapp_delivery_note,
    gapp_delivery_note_id: gapp_delivery_note?.id || null,
    gapp_dn_number: gapp_delivery_note?.dn_number || null,
  };
}

async function listHuaweiDeliveryNotes({ q, limit = 200 } = {}) {
  const lim = Math.min(500, Math.max(1, Number(limit) || 200));
  const params = [];
  let sql = `SELECT h.*, u.username AS created_by_name
    FROM huawei_delivery_notes h
    LEFT JOIN users u ON u.id = h.created_by
    WHERE 1=1`;
  if (q) {
    const like = `%${String(q).trim()}%`;
    sql += ` AND (h.dn_number LIKE ? OR h.customer_name LIKE ? OR h.source_dsa_numbers LIKE ? OR h.source_sap_po LIKE ?)`;
    params.push(like, like, like, like);
  }
  sql += ` ORDER BY h.id DESC LIMIT ?`;
  params.push(lim);
  const rows = await dbAll(sql, params);
  return { rows };
}

async function getHuaweiDeliveryNote(id) {
  const header = await dbGet(`SELECT * FROM huawei_delivery_notes WHERE id = ?`, [Number(id)]);
  if (!header) throw Object.assign(new Error('Huawei delivery note not found'), { statusCode: 404 });
  const dnItemCols = await getHuaweiDnItemColumns();
  const items = await dbAll(
    `SELECT * FROM huawei_delivery_note_items WHERE huawei_dn_id = ? ${orderClauseForDnItems(dnItemCols)}`,
    [Number(id)]
  );
  return {
    ...header,
    items,
    boxes: groupItemsByBox(
      items.map((r) => ({
        ...r,
        box_name: r.box_name,
        qty: r.quantity,
      }))
    ),
  };
}

module.exports = {
  createHuaweiDeliveryNote,
  listHuaweiDeliveryNotes,
  getHuaweiDeliveryNote,
  fetchReceivedItems,
  fetchReceivedPackingLines,
  previewHuaweiDeliveryNote,
  validatePoForHuaweiDn,
  groupItemsByBox,
  normPo,
  prepareDnLinesForMode,
};
