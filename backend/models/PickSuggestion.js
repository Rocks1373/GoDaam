const sqlite3 = require('sqlite3').verbose();
const StockByRack = require('./StockByRack');

const DB_PATH = process.env.DB_PATH || './warehouse.db';

class PickSuggestion {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH);
    this.stockByRack = new StockByRack();
  }

  async getOrCreateOutboundId(outbound_number) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT id FROM outbound_orders WHERE outbound_number = ?',
        [outbound_number],
        (err, row) => {
          if (err) return reject(err);
          if (row?.id) return resolve(row.id);

          this.db.run(
            'INSERT INTO outbound_orders (outbound_number, status) VALUES (?, ?)',
            [outbound_number, 'pending'],
            function (err2) {
              if (err2) return reject(err2);
              resolve(this.lastID);
            }
          );
        }
      );
    });
  }

  async clearSuggestionsForPart(outbound_id, part_number) {
    return new Promise((resolve, reject) => {
      this.db.run(
        'DELETE FROM pick_suggestions WHERE outbound_id = ? AND part_number = ?',
        [outbound_id, part_number],
        function (err) {
          if (err) reject(err);
          else resolve({ deleted: this.changes || 0 });
        }
      );
    });
  }

  async insertSuggestions(outbound_id, part_number, suggestions) {
    return new Promise((resolve, reject) => {
      if (!suggestions.length) return resolve({ inserted: 0 });

      const stmt = this.db.prepare(
        `INSERT INTO pick_suggestions
         (outbound_id, part_number, rack_location, entry_id, suggested_qty, fifo_sequence, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );

      let inserted = 0;
      this.db.serialize(() => {
        for (const s of suggestions) {
          stmt.run(
            [
              outbound_id,
              part_number,
              s.rack_location,
              s.entry_id,
              s.suggested_qty,
              s.fifo_sequence,
              'suggested',
            ],
            (err) => {
              if (err) return reject(err);
              inserted += 1;
            }
          );
        }
        stmt.finalize((err) => {
          if (err) reject(err);
          else resolve({ inserted });
        });
      });
    });
  }

  async generateSuggestions({ outbound_number, part_number, required_qty }) {
    if (!part_number) throw new Error('part_number is required');
    if (!outbound_number) throw new Error('outbound_number is required');
    if (typeof required_qty !== 'number' || Number.isNaN(required_qty) || required_qty <= 0) {
      throw new Error('required_qty must be a positive number');
    }

    const candidates = await this.stockByRack.findAll({
      part_number,
      available_only: true,
      page: 1,
      limit: 500,
    });

    const totalAvailable = candidates.reduce((sum, r) => sum + (Number(r.available_qty) || 0), 0);

    if (totalAvailable < required_qty) {
      return {
        ok: false,
        outbound_number,
        part_number,
        required_qty,
        total_available_qty: totalAvailable,
        shortage_qty: required_qty - totalAvailable,
        suggestions: [],
      };
    }

    let remaining = required_qty;
    const suggestions = [];
    let seq = 1;
    for (const row of candidates) {
      const avail = Number(row.available_qty) || 0;
      if (avail <= 0) continue;
      if (remaining <= 0) break;

      const take = Math.min(avail, remaining);
      suggestions.push({
        part_number,
        rack_location: row.rack_location,
        entry_id: row.entry_id,
        entry_date: row.entry_date,
        available_qty: avail,
        suggested_qty: take,
        fifo_sequence: seq++,
      });
      remaining -= take;
    }

    const outbound_id = await this.getOrCreateOutboundId(outbound_number);
    await this.clearSuggestionsForPart(outbound_id, part_number);
    await this.insertSuggestions(outbound_id, part_number, suggestions);

    return {
      ok: true,
      outbound_id,
      outbound_number,
      part_number,
      required_qty,
      total_available_qty: totalAvailable,
      shortage_qty: 0,
      suggestions,
    };
  }

  async getByOutbound(outbound_id) {
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT ps.*, sbr.entry_date, sbr.available_qty as rack_available_qty
         FROM pick_suggestions ps
         LEFT JOIN stock_by_rack_legacy sbr ON sbr.entry_id = ps.entry_id
         WHERE ps.outbound_id = ?
         ORDER BY ps.part_number ASC, ps.fifo_sequence ASC, ps.id ASC`,
        [outbound_id],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  close() {
    this.db.close();
    this.stockByRack.close();
  }
}

module.exports = PickSuggestion;
