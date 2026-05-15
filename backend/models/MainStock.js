const { promisify } = require('util');
const db = require('../db');

class MainStock {
  constructor() {
    this.db = db;
  }

  /** available = received − sold_out − pending_delivery (sold_out mirrors legacy issued_qty in DB). */
  static computeAvailableQty({ received_qty = 0, sold_out_qty, issued_qty = 0, pending_delivery_qty = 0 }) {
    const r = Number(received_qty) || 0;
    const sold =
      sold_out_qty !== undefined && sold_out_qty !== null ? Number(sold_out_qty) || 0 : Number(issued_qty) || 0;
    const p = Number(pending_delivery_qty) || 0;
    return r - sold - p;
  }

  static normalizeSold(stockData) {
    const raw =
      stockData.sold_out_qty !== undefined && stockData.sold_out_qty !== null
        ? stockData.sold_out_qty
        : stockData.issued_qty;
    const sold = Number(raw) || 0;
    return { sold_out_qty: sold, issued_qty: sold };
  }

  async _defaultWarehouseId() {
    const get = promisify(this.db.get.bind(this.db));
    const row = await get(`SELECT id FROM warehouses ORDER BY id LIMIT 1`);
    return Number(row?.id) || null;
  }

  // Create or Update (upsert by warehouse_id + part_number; preserves id)
  async upsertByPartNumber(stockData) {
    return new Promise((resolve, reject) => {
      const {
        product,
        vendor_name,
        vendor_number,
        sap_part_number,
        sap_qty,
        part_number,
        description,
        received_qty = 0,
        pending_delivery_qty = 0,
        uom,
        remarks,
        warehouse_id: whIn,
      } = stockData;
      const { sold_out_qty, issued_qty } = MainStock.normalizeSold(stockData);

      if (!part_number) return reject(new Error('part_number is required'));

      const runUpsert = (warehouse_id) => {
        const available_qty = MainStock.computeAvailableQty({
          received_qty,
          sold_out_qty,
          pending_delivery_qty,
        });
        if (available_qty < 0) return reject(new Error('available_qty cannot be negative'));

        this.db.run(
          `INSERT INTO main_stock
          (product, vendor_name, vendor_number, sap_part_number, sap_qty, part_number,
           description, received_qty, issued_qty, sold_out_qty, pending_delivery_qty,
           available_qty, uom, remarks, last_updated, created_at, updated_at, warehouse_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)
         ON CONFLICT(warehouse_id, part_number) DO UPDATE SET
           product = excluded.product,
           vendor_name = excluded.vendor_name,
           vendor_number = excluded.vendor_number,
           sap_part_number = excluded.sap_part_number,
           sap_qty = COALESCE(excluded.sap_qty, main_stock.sap_qty),
           description = excluded.description,
           received_qty = excluded.received_qty,
           issued_qty = excluded.issued_qty,
           sold_out_qty = excluded.sold_out_qty,
           pending_delivery_qty = excluded.pending_delivery_qty,
           available_qty = excluded.available_qty,
           uom = excluded.uom,
           remarks = excluded.remarks,
           last_updated = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP`,
          [
            product,
            vendor_name,
            vendor_number,
            sap_part_number,
            sap_qty === undefined || sap_qty === null ? null : Number(sap_qty),
            part_number,
            description,
            Number(received_qty) || 0,
            issued_qty,
            sold_out_qty,
            Number(pending_delivery_qty) || 0,
            available_qty,
            uom,
            remarks,
            warehouse_id,
          ],
          function (err) {
            if (err) reject(err);
            else resolve({ part_number, available_qty, warehouse_id });
          }
        );
      };

      let wh = whIn != null && whIn !== '' ? Number(whIn) : null;
      if (wh && Number.isFinite(wh) && wh > 0) {
        return runUpsert(wh);
      }
      this._defaultWarehouseId()
        .then((id) => {
          wh = id;
          if (!wh) return reject(new Error('warehouse_id is required (no default warehouse)'));
          return runUpsert(wh);
        })
        .catch(reject);
    });
  }

  // Get all with search/filter
  async findAll({ search = '', page = 1, limit = 50, sort = 'part_number', warehouse_id: whFilter } = {}) {
    return new Promise((resolve, reject) => {
      const offset = (page - 1) * limit;
      const searchTerm = `%${search}%`;
      const wh = whFilter != null && whFilter !== '' ? Number(whFilter) : null;
      const whClause = wh && Number.isFinite(wh) && wh > 0 ? ' AND warehouse_id = ? ' : '';
      const params = wh && Number.isFinite(wh) && wh > 0
        ? [searchTerm, searchTerm, searchTerm, searchTerm, wh, limit, offset]
        : [searchTerm, searchTerm, searchTerm, searchTerm, limit, offset];

      this.db.all(
        `SELECT * FROM main_stock 
         WHERE (part_number LIKE ? OR sap_part_number LIKE ? 
           OR vendor_number LIKE ? OR description LIKE ?) ${whClause}
         ORDER BY ${sort} ASC 
         LIMIT ? OFFSET ?`,
        params,
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Get by part_number + warehouse
  async findByPartNumber(part_number, warehouse_id = null) {
    return new Promise((resolve, reject) => {
      const run = () => {
        const wh = warehouse_id != null && warehouse_id !== '' ? Number(warehouse_id) : null;
        const sql =
          wh && Number.isFinite(wh) && wh > 0
            ? 'SELECT * FROM main_stock WHERE part_number = ? AND warehouse_id = ?'
            : 'SELECT * FROM main_stock WHERE part_number = ? ORDER BY id LIMIT 1';
        const params = wh && Number.isFinite(wh) && wh > 0 ? [part_number, wh] : [part_number];
        this.db.get(sql, params, (err, row) => {
          if (err) reject(err);
          else resolve(row);
        });
      };
      run();
    });
  }

  /** Match Material (part_number) or SAP Part Number for outbound stock check */
  async findByPartOrSap(material, sapPartNumber, warehouse_id = null) {
    const keys = [...new Set([String(material || '').trim(), String(sapPartNumber || '').trim()].filter(Boolean))];
    return new Promise((resolve, reject) => {
      if (!keys.length) return resolve(null);
      const ph = keys.map(() => '?').join(', ');
      const wh = warehouse_id != null && warehouse_id !== '' ? Number(warehouse_id) : null;
      const whClause = wh && Number.isFinite(wh) && wh > 0 ? ' AND warehouse_id = ? ' : '';
      const baseParams = [...keys, ...keys];
      const params = wh && Number.isFinite(wh) && wh > 0 ? [...baseParams, wh] : baseParams;
      const sql = `SELECT * FROM main_stock WHERE (part_number IN (${ph}) OR sap_part_number IN (${ph})) ${whClause} LIMIT 1`;
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      });
    });
  }

  async findById(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM main_stock WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  /** Inbound receiving: add qty to received_qty; leaves sold_out / pending unchanged; recalculates available. */
  async incrementReceivedByPartNumber(part_number, inboundQty, patch = {}) {
    const delta = Number(inboundQty) || 0;
    if (!(delta > 0)) throw new Error('inbound_qty must be > 0');
    const pn = String(part_number || '').trim();
    if (!pn) throw new Error('part_number is required');

    let wh = patch.warehouse_id != null ? Number(patch.warehouse_id) : null;
    if (!wh || !Number.isFinite(wh)) {
      wh = await this._defaultWarehouseId();
    }
    if (!wh) throw new Error('warehouse_id required for main stock increment');

    const existing = await this.findByPartNumber(pn, wh);
    if (!existing) {
      return this.upsertByPartNumber({
        part_number: pn,
        warehouse_id: wh,
        product: patch.product ?? null,
        vendor_name: patch.vendor_name ?? patch.batch_vendor_name ?? null,
        vendor_number: patch.vendor_number ?? null,
        sap_part_number: patch.sap_part_number ?? pn,
        sap_qty: patch.sap_qty,
        description: patch.description ?? '',
        received_qty: delta,
        sold_out_qty: 0,
        pending_delivery_qty: 0,
        uom: patch.uom ?? null,
        remarks: patch.remarks ?? null,
      });
    }

    const rec = Number(existing.received_qty) || 0;
    const sold = Number(existing.sold_out_qty ?? existing.issued_qty) || 0;
    const pend = Number(existing.pending_delivery_qty) || 0;
    const nextRec = rec + delta;

    return this.updateById(existing.id, {
      product: patch.product !== undefined ? patch.product : existing.product,
      vendor_name: patch.vendor_name !== undefined ? patch.vendor_name : existing.vendor_name,
      vendor_number: patch.vendor_number !== undefined ? patch.vendor_number : existing.vendor_number,
      sap_part_number: patch.sap_part_number !== undefined ? patch.sap_part_number : existing.sap_part_number,
      sap_qty: patch.sap_qty !== undefined ? patch.sap_qty : existing.sap_qty,
      part_number: pn,
      description: patch.description !== undefined ? patch.description : existing.description,
      received_qty: nextRec,
      sold_out_qty: sold,
      pending_delivery_qty: pend,
      uom: patch.uom !== undefined ? patch.uom : existing.uom,
      remarks: patch.remarks !== undefined ? patch.remarks : existing.remarks,
      warehouse_id: existing.warehouse_id ?? wh,
    });
  }

  async updateById(id, stockData) {
    return new Promise((resolve, reject) => {
      const {
        product,
        vendor_name,
        vendor_number,
        sap_part_number,
        sap_qty,
        part_number,
        description,
        received_qty = 0,
        pending_delivery_qty = 0,
        uom,
        remarks,
      } = stockData;
      const { sold_out_qty, issued_qty } = MainStock.normalizeSold(stockData);

      if (!part_number) return reject(new Error('part_number is required'));
      const available_qty = MainStock.computeAvailableQty({
        received_qty,
        sold_out_qty,
        pending_delivery_qty,
      });
      if (available_qty < 0) return reject(new Error('available_qty cannot be negative'));

      this.db.run(
        `UPDATE main_stock SET
           product = ?,
           vendor_name = ?,
           vendor_number = ?,
           sap_part_number = ?,
           sap_qty = COALESCE(?, sap_qty),
           part_number = ?,
           description = ?,
           received_qty = ?,
           issued_qty = ?,
           sold_out_qty = ?,
           pending_delivery_qty = ?,
           available_qty = ?,
           uom = ?,
           remarks = ?,
           last_updated = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          product,
          vendor_name,
          vendor_number,
          sap_part_number,
          sap_qty === undefined || sap_qty === null ? null : Number(sap_qty),
          part_number,
          description,
          Number(received_qty) || 0,
          issued_qty,
          sold_out_qty,
          Number(pending_delivery_qty) || 0,
          available_qty,
          uom,
          remarks,
          id,
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ id, changes: this.changes || 0, part_number, available_qty });
        }
      );
    });
  }

  async deleteById(id) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM main_stock WHERE id = ?', [id], function (err) {
        if (err) reject(err);
        else resolve({ deleted: this.changes > 0 });
      });
    });
  }

  // Delete by part + warehouse
  async delete(part_number, warehouse_id = null) {
    return new Promise((resolve, reject) => {
      const wh = warehouse_id != null && warehouse_id !== '' ? Number(warehouse_id) : null;
      const sql =
        wh && Number.isFinite(wh) && wh > 0
          ? 'DELETE FROM main_stock WHERE part_number = ? AND warehouse_id = ?'
          : 'DELETE FROM main_stock WHERE part_number = ?';
      const params = wh && Number.isFinite(wh) && wh > 0 ? [part_number, wh] : [part_number];
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ deleted: this.changes > 0 });
      });
    });
  }

  close() {
    /* shared pool / sqlite handle owned by db module */
  }
}

module.exports = MainStock;
