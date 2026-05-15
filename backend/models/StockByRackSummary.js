const db = require('../db');

class StockByRackSummary {
  constructor() {
    this.db = db;
  }

  async list({
    part_number,
    sap_part_number,
    rack_location,
    search = '',
    available_only = false,
    limit = 200,
    offset = 0,
    warehouse_id,
  } = {}) {
    return new Promise((resolve, reject) => {
      let query = `
        SELECT *
        FROM stock_by_rack
        WHERE 1=1
      `;
      const params = [];

      if (warehouse_id != null && Number(warehouse_id) > 0) {
        query += ' AND warehouse_id = ?';
        params.push(Number(warehouse_id));
      }
      if (part_number) {
        query += ' AND part_number LIKE ?';
        params.push(`%${part_number}%`);
      }
      if (sap_part_number) {
        query += ' AND sap_part_number LIKE ?';
        params.push(`%${sap_part_number}%`);
      }
      if (rack_location) {
        query += ' AND rack_location LIKE ?';
        params.push(`%${rack_location}%`);
      }
      if (search) {
        query += ' AND (part_number LIKE ? OR sap_part_number LIKE ? OR description LIKE ? OR rack_location LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (available_only) {
        query += ' AND available_qty > 0';
      }

      query += ' ORDER BY rack_location ASC, part_number ASC LIMIT ? OFFSET ?';
      params.push(Number(limit) || 200, Number(offset) || 0);

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = StockByRackSummary;

