const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const DB_PATH = process.env.DB_PATH || './warehouse.db';

class OutboundOrder {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH);
  }

  // Create new outbound order
  async create(orderData) {
    return new Promise((resolve, reject) => {
      const {
        outbound_number,
        sales_order_number,
        customer_po_number,
        customer_name,
        vendor_name,
        dn_date,
        gapp_po,
        invoice_number,
        delivery_address,
        contact_person,
        total_cases,
        gross_weight,
        volume,
        dn_status,
      } = orderData;

      this.db.run(
        `INSERT INTO outbound_orders 
         (outbound_number, sales_order_number, customer_po_number, 
          customer_name, vendor_name,
          dn_date, gapp_po, invoice_number, delivery_address, contact_person,
          total_cases, gross_weight, volume, dn_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          outbound_number,
          sales_order_number,
          customer_po_number,
          customer_name,
          vendor_name,
          dn_date,
          gapp_po,
          invoice_number,
          delivery_address,
          contact_person,
          total_cases,
          gross_weight,
          volume,
          dn_status,
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, outbound_number });
        }
      );
    });
  }

  // Get all orders with pagination and search
  async findAll({ search = '', status = '', page = 1, limit = 20 }) {
    return new Promise((resolve, reject) => {
      const offset = (page - 1) * limit;
      let query = `
        SELECT *, 
               (SELECT SUM(required_qty - picked_qty) FROM outbound_items WHERE outbound_id = outbound_orders.id) as pending_qty
        FROM outbound_orders 
        WHERE 1=1
      `;
      const params = [];

      if (search) {
        query += ' AND (outbound_number LIKE ? OR customer_name LIKE ? OR sales_order_number LIKE ?)';
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (status) {
        query += ' AND status = ?';
        params.push(status);
      }

      query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      this.db.all(query, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  // Get order by ID with items
  async findById(id) {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM outbound_orders WHERE id = ?`,
        [id],
        (err, order) => {
          if (err) reject(err);
          else if (!order) resolve(null);
          else {
            // Get items
            this.db.all(
              `SELECT * FROM outbound_items WHERE outbound_id = ? ORDER BY id`,
              [id],
              (err2, items) => {
                if (err2) reject(err2);
                else resolve({ ...order, items });
              }
            );
          }
        }
      );
    });
  }

  // Update order status
  async updateStatus(id, status) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'UPDATE outbound_orders SET status = ? WHERE id = ?',
        [status, id],
        function(err) {
          if (err) reject(err);
          else resolve({ id, status, changes: this.changes > 0 });
        }
      );
    });
  }

  close() {
    this.db.close();
  }
}

module.exports = OutboundOrder;
