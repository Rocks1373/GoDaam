const db = require('../db');

class StockByRack {
  constructor() {
    this.db = db;
  }

  tableName() {
    return 'stock_by_rack_legacy';
  }

  static computeAvailableQty({ qty_received = 0, qty_issued = 0 }) {
    const r = Number(qty_received) || 0;
    const i = Number(qty_issued) || 0;
    return r - i;
  }

  // Create new rack entry
  async create(rackData) {
    return new Promise((resolve, reject) => {
      const {
        part_number, sap_part_number, description, rack_location,
        entry_date, qty_received = 0, qty_issued = 0, remarks, source_type = 'manual'
      } = rackData;

      if (!part_number) return reject(new Error('part_number is required'));
      if (!rack_location) return reject(new Error('rack_location is required'));
      if (!entry_date) return reject(new Error('entry_date is required'));

      const available_qty = StockByRack.computeAvailableQty({ qty_received, qty_issued });
      if (available_qty < 0) return reject(new Error('available_qty cannot be negative'));

      this.db.run(
        `INSERT INTO ${this.tableName()} 
         (part_number, sap_part_number, description, rack_location, entry_date,
          qty_received, qty_issued, available_qty, remarks, source_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [part_number, sap_part_number, description, rack_location, entry_date,
         qty_received, qty_issued, available_qty, remarks, source_type],
        function(err) {
          if (err) reject(err);
          else resolve({ entry_id: this.lastID, available_qty });
        }
      );
    });
  }

  // Update existing by composite key (part_number + rack_location + entry_date)
  async upsertByComposite(rackData) {
    return new Promise((resolve, reject) => {
      const {
        part_number,
        sap_part_number,
        description,
        rack_location,
        entry_date,
        qty_received = 0,
        qty_issued = 0,
        remarks,
        source_type = 'manual',
      } = rackData;

      if (!part_number) return reject(new Error('part_number is required'));
      if (!rack_location) return reject(new Error('rack_location is required'));
      if (!entry_date) return reject(new Error('entry_date is required'));

      const available_qty = StockByRack.computeAvailableQty({ qty_received, qty_issued });
      if (available_qty < 0) return reject(new Error('available_qty cannot be negative'));

      this.db.run(
        `INSERT INTO ${this.tableName()}
           (part_number, sap_part_number, description, rack_location, entry_date,
            qty_received, qty_issued, available_qty, remarks, source_type, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(part_number, rack_location, entry_date) DO UPDATE SET
           sap_part_number = excluded.sap_part_number,
           description = excluded.description,
           qty_received = excluded.qty_received,
           qty_issued = excluded.qty_issued,
           available_qty = excluded.available_qty,
           remarks = excluded.remarks,
           source_type = excluded.source_type,
           updated_at = CURRENT_TIMESTAMP`,
        [
          part_number,
          sap_part_number,
          description,
          rack_location,
          entry_date,
          Number(qty_received) || 0,
          Number(qty_issued) || 0,
          available_qty,
          remarks,
          source_type,
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ part_number, rack_location, entry_date, available_qty });
        }
      );
    });
  }

  // Update existing rack entry
  async update(entry_id, rackData) {
    return new Promise((resolve, reject) => {
      const { qty_received, qty_issued, remarks } = rackData;
      const available_qty = StockByRack.computeAvailableQty({ qty_received, qty_issued });
      if (available_qty < 0) return reject(new Error('available_qty cannot be negative'));

      this.db.run(
        `UPDATE ${this.tableName()} 
         SET qty_received = ?, qty_issued = ?, available_qty = ?, 
             remarks = ?, updated_at = CURRENT_TIMESTAMP
         WHERE entry_id = ?`,
        [qty_received, qty_issued, available_qty, remarks, entry_id],
        function(err) {
          if (err) reject(err);
          else resolve({ entry_id, changes: this.changes > 0, available_qty });
        }
      );
    });
  }

  // Get all with filters (FIFO ready)
  async findAll({ part_number, rack_location, search = '', available_only = false, page = 1, limit = 50 }) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT * FROM ${this.tableName()} 
        WHERE 1=1
      `;
      const params = [];

      if (part_number) {
        query += ' AND part_number = ?';
        params.push(part_number);
      }
      if (rack_location) {
        query += ' AND rack_location LIKE ?';
        params.push(`%${rack_location}%`);
      }
      if (search) {
        query += ' AND (description LIKE ? OR rack_location LIKE ? OR part_number LIKE ? OR sap_part_number LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (available_only) {
        query += ' AND available_qty > 0';
      }

      query += ' ORDER BY entry_date ASC, entry_id ASC LIMIT ? OFFSET ?';
      params.push(limit, (page - 1) * limit);

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Get FIFO candidates for picking
  async getFIFOCandidates(part_number, required_qty) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT entry_id, rack_location, entry_date, available_qty, 
                MIN(available_qty, ?) as suggested_qty
         FROM ${this.tableName()} 
         WHERE part_number = ? AND available_qty > 0
         ORDER BY entry_date ASC, entry_id ASC
         LIMIT 10`,
        [required_qty, part_number],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Delete rack entry
  async delete(entry_id) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `DELETE FROM ${this.tableName()} WHERE entry_id = ?`,
        [entry_id],
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

module.exports = StockByRack;
