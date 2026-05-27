/**
 * Sync Huawei RECEIVED packing lines into GAPP delivery_notes + delivery_note_items (box-wise).
 */
const { promisify } = require('util');
const db = require('../db');
const { insertRowById } = require('../utils/dbRun');
const { asNumber } = require('./deliveryWorkflow');
const { getDefaultWarehouseId } = require('./warehouseContext');
const { resolveDnLineMasterFields } = require('./dnMasterDataLookup');
const {
  fetchReceivedPackingLines,
  prepareDnLinesForMode,
  validatePoForHuaweiDn,
} = require('./huaweiDnPageService');
const { normPo } = require('./huaweiDnPageHelpers');

const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

const HUAWEI_SYSTEM_PO_LABEL = 'Huawei B2B';

function trimStr(v) {
  return String(v ?? '').trim();
}

function parseDnDateOnly(raw) {
  const s = trimStr(raw);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

async function findExistingGappDnForPo(po) {
  const p = normPo(po);
  const dnRef = `HW-PO-${p}`;
  return dbGet(
    `SELECT id FROM delivery_notes
     WHERE TRIM(COALESCE(dn_number, '')) = TRIM(?)
        OR (COALESCE(is_huawei_source, 0) = 1 AND TRIM(COALESCE(customer_po, '')) = TRIM(?))
     LIMIT 1`,
    [dnRef, p]
  );
}

async function resolveCustomerPoFromSapSo(sapSo) {
  if (!sapSo || sapSo === HUAWEI_SYSTEM_PO_LABEL) return null;
  // 1. Try to find in outbound_orders
  const outRow = await dbGet(
    `SELECT customer_reference FROM outbound_orders
     WHERE (TRIM(sales_order_number) = ? OR TRIM(sales_doc) = ?)
       AND customer_reference IS NOT NULL AND TRIM(customer_reference) != ''
     ORDER BY id DESC LIMIT 1`,
    [sapSo, sapSo]
  );
  if (outRow?.customer_reference) return outRow.customer_reference.trim();

  // 2. Try to find in sap_po_lines
  const sapRow = await dbGet(
    `SELECT customer_reference FROM sap_po_lines
     WHERE TRIM(sales_order_number) = ?
       AND customer_reference IS NOT NULL AND TRIM(customer_reference) != ''
     ORDER BY id DESC LIMIT 1`,
    [sapSo]
  );
  if (sapRow?.customer_reference) return sapRow.customer_reference.trim();

  return null;
}

/**
 * Insert or rebuild delivery_notes + box-wise delivery_note_items from Huawei packing lines.
 * @param {object} opts
 * @param {string} opts.sap_po
 * @param {number} opts.warehouseId
 * @param {number} opts.userId
 * @param {boolean} opts.rebuild
 * @param {string} [opts.dn_date]
 * @param {object[]} [opts.rawLines] — if omitted, loaded from DB for PO
 */
async function syncGappDeliveryNoteFromHuaweiPo({
  sap_po,
  warehouseId: warehouseIdIn,
  userId = null,
  rebuild = true,
  dn_date = null,
  rawLines = null,
} = {}) {
  const po = normPo(sap_po);
  if (!po) {
    const err = new Error('sap_po is required');
    err.statusCode = 400;
    throw err;
  }

  const warehouseId = Number(warehouseIdIn) || (await getDefaultWarehouseId());
  if (!warehouseId) {
    const err = new Error('warehouse_id could not be resolved for Huawei DN');
    err.statusCode = 400;
    throw err;
  }

  const dnDate = parseDnDateOnly(dn_date) || new Date().toISOString().slice(0, 10);
  const dnRef = `HW-PO-${po}`;
  const existing = await findExistingGappDnForPo(po);
  if (existing?.id && !rebuild) {
    return { id: existing.id, dn_number: dnRef, rebuilt: false, item_count: null };
  }

  let lines = rawLines;
  if (!lines?.length) {
    const check = await validatePoForHuaweiDn(po, warehouseId);
    if (!check.valid) {
      const err = new Error(check.errors?.[0] || `No received Huawei lines for PO ${po}`);
      err.statusCode = 400;
      err.details = check.errors;
      throw err;
    }
    lines = check.items || (await fetchReceivedPackingLines({ sapPo: po, warehouseId }));
  }
  if (!lines?.length) {
    const err = new Error(`No received Huawei packing lines for PO ${po}`);
    err.statusCode = 400;
    throw err;
  }

  const { total_weight_kg: totalWeight, total_volume_cbm: totalVolume } = prepareDnLinesForMode(
    lines,
    'box'
  );
  const boxSet = new Set();
  for (const ln of lines) {
    const bn = trimStr(ln.box_name || ln.box_number);
    if (bn) boxSet.add(bn);
  }
  const boxQty = boxSet.size;

  const first = lines[0] || {};
  const contractNumber = trimStr(
    first.huawei_contract || first.contract_number || null
  );
  const resellerName = trimStr(
    first.reseller_name ||
      (lines.find((r) => trimStr(r.reseller_name)) || {}).reseller_name
  );
  const customerName = trimStr(first.reseller_name) || trimStr(first.customer_name) || 'Huawei Customer';
  const salesOrderNumber = trimStr(first.sap_so) || HUAWEI_SYSTEM_PO_LABEL;
  let customerPo = trimStr(first.customer_po_number || first.sap_po || po);
  const sapCustomerRef = await resolveCustomerPoFromSapSo(salesOrderNumber);
  if (sapCustomerRef) {
    customerPo = sapCustomerRef;
  }

  await dbRun('BEGIN IMMEDIATE');
  try {
    let dnId;
    if (existing?.id && rebuild) {
      dnId = existing.id;
      await dbRun(`DELETE FROM delivery_note_items WHERE dn_id = ?`, [dnId]);
      await dbRun(
        `UPDATE delivery_notes SET
          dn_date = ?, sales_order_number = ?, gapp_po = ?, customer_po = ?,
          outbound_number = NULL, invoice_number = COALESCE(invoice_number, ''),
          customer_name = ?, reseller_name = ?, huawei_contract = ?, is_huawei_source = 1,
          package_type = 'Box', pallet_qty = 0, box_qty = ?, gross_weight_kg = ?, volume_cbm = ?,
          warehouse_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          dnDate,
          salesOrderNumber,
          salesOrderNumber,
          customerPo,
          customerName,
          resellerName,
          contractNumber,
          boxQty,
          totalWeight,
          totalVolume,
          Number(warehouseId),
          dnId,
        ]
      );
    } else {
      const dnRow = await insertRowById(
        db,
        dbGet,
        `INSERT INTO delivery_notes (
          dn_number, dn_date, sales_order_number, gapp_po, customer_po, outbound_number, invoice_number,
          customer_id, customer_number, customer_name, delivery_address, gps, contact_person, contact_number,
          reseller_name, huawei_contract, is_huawei_source,
          package_type, pallet_qty, box_qty, gross_weight_kg, volume_cbm,
          warehouse_id, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Draft', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          dnRef,
          dnDate,
          salesOrderNumber,
          salesOrderNumber,
          customerPo,
          null,
          '',
          null,
          '',
          customerName,
          '',
          '',
          '',
          '',
          resellerName,
          contractNumber,
          1,
          'Box',
          0,
          boxQty,
          totalWeight,
          totalVolume,
          Number(warehouseId),
        ],
        'delivery_notes'
      );
      dnId = dnRow.id;
    }
    let itemNo = 1;
    let inserted = 0;
    for (const it of lines) {
      const pn = trimStr(it.part_number);
      if (!pn) continue;
      const sap = trimStr(it.sap_part_number || it.part_number);
      const { description: desc, uom } = await resolveDnLineMasterFields(pn, sap, Number(warehouseId), {
        description: it.description,
        uom: it.uom,
      });
      const boxName = trimStr(it.box_name || it.box_number);
      await dbRun(
        `INSERT INTO delivery_note_items
          (dn_id, warehouse_id, item_no, part_number, sap_part_number, description, qty, uom, serial_no, condition_text, box_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          dnId,
          Number(warehouseId),
          itemNo++,
          pn,
          sap,
          desc,
          asNumber(it.qty ?? it.quantity) || 1,
          uom,
          '-',
          'New',
          boxName || null,
        ]
      );
      inserted += 1;
    }

    if (!inserted) {
      throw Object.assign(new Error('No line items could be written to the delivery note'), {
        statusCode: 400,
      });
    }

    await dbRun('COMMIT');
    return {
      id: dnId,
      dn_number: dnRef,
      customer_po: customerPo,
      item_count: inserted,
      box_qty: boxQty,
      rebuilt: Boolean(existing?.id && rebuild),
    };
  } catch (e) {
    await dbRun('ROLLBACK').catch(() => {});
    throw e;
  }
}

module.exports = {
  syncGappDeliveryNoteFromHuaweiPo,
  findExistingGappDnForPo,
  HUAWEI_SYSTEM_PO_LABEL,
};
