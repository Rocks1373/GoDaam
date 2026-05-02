const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const DB_PATH = process.env.DB_PATH || './warehouse.db';

class OutboundItem {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH);
  }

  // Create outbound item
  async create(outboundData) {
    return new Promise((resolve, reject) => {
      const { outbound_id, part_number, sap_part_number, description, required_qty, uom, serial_no, condition } =
        outboundData;

      this.db.run(
        `INSERT INTO outbound_items 
         (outbound_id, part_number, sap_part_number, description, required_qty, uom, serial_no, condition)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [outbound_id, part_number, sap_part_number, description, required_qty, uom, serial_no, condition],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, part_number });
        }
      );
    });
  }

  // Update picked quantity and status
  async updatePicked(id, picked_qty, status = 'picked') {
    const database = this.db;
    return new Promise((resolve, reject) => {
      database.run(
        `UPDATE outbound_items 
         SET picked_qty = ?, status = ?
         WHERE id = ?`,
        [picked_qty, status, id],
        function (err) {
          if (err) reject(err);
          else {
            database.get(
              'SELECT * FROM outbound_items WHERE id = ?',
              [id],
              (err2, item) => {
                if (err2) reject(err2);
                else resolve(item);
              }
            );
          }
        }
      );
    });
  }

  // Get pending items for outbound
  async getPending(outbound_id) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM outbound_items 
         WHERE outbound_id = ? AND picked_qty < required_qty
         ORDER BY id`,
        [outbound_id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  // Delete item
  async delete(id) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM outbound_items WHERE id = ?',
        [id],
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

module.exports = OutboundItem;
