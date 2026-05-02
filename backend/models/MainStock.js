const sqlite3 = require('sqlite3').verbose();
const DB_PATH = process.env.DB_PATH || './warehouse.db';

class MainStock {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH);
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

  // Create or Update (upsert by part_number; preserves id)
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
        `INSERT INTO main_stock
          (product, vendor_name, vendor_number, sap_part_number, sap_qty, part_number,
           description, received_qty, issued_qty, sold_out_qty, pending_delivery_qty,
           available_qty, uom, remarks, last_updated, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT(part_number) DO UPDATE SET
           product = excluded.product,
           vendor_name = excluded.vendor_name,
           vendor_number = excluded.vendor_number,
           sap_part_number = excluded.sap_part_number,
           sap_qty = COALESCE(excluded.sap_qty, sap_qty),
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
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ part_number, available_qty });
        }
      );
    });
  }

  // Get all with search/filter
  async findAll({ search = '', page = 1, limit = 50, sort = 'part_number' }) {
    return new Promise((resolve, reject) => {
      const offset = (page - 1) * limit;
      const searchTerm = `%${search}%`;
      
      this.db.all(
        `SELECT * FROM main_stock 
         WHERE part_number LIKE ? OR sap_part_number LIKE ? 
           OR vendor_number LIKE ? OR description LIKE ?
         ORDER BY ${sort} ASC 
         LIMIT ? OFFSET ?`,
        [searchTerm, searchTerm, searchTerm, searchTerm, limit, offset],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Get by part_number
  async findByPartNumber(part_number) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM main_stock WHERE part_number = ?',
        [part_number],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  /** Match Material (part_number) or SAP Part Number for outbound stock check */
  async findByPartOrSap(material, sapPartNumber) {
    const keys = [...new Set([String(material || '').trim(), String(sapPartNumber || '').trim()].filter(Boolean))];
    return new Promise((resolve, reject) => {
      if (!keys.length) return resolve(null);
      const ph = keys.map(() => '?').join(', ');
      const sql = `SELECT * FROM main_stock WHERE part_number IN (${ph}) OR sap_part_number IN (${ph}) LIMIT 1`;
      this.db.get(sql, [...keys, ...keys], (err, row) => {
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

    const existing = await this.findByPartNumber(pn);
    if (!existing) {
      return this.upsertByPartNumber({
        part_number: pn,
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

  // Delete
  async delete(part_number) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM main_stock WHERE part_number = ?',
        [part_number],
        function(err) {
          if (err) reject(err);
          else resolve({ deleted: this.changes > 0 });
        }
      );
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = MainStock;
