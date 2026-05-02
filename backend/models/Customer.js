const sqlite3 = require('sqlite3').verbose();

const DB_PATH = process.env.DB_PATH || './warehouse.db';

function cleanStr(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function normalizeAddressType(v) {
  const x = String(v || '').trim().toLowerCase();
  if (x === 'temporary') return 'temporary';
  return 'permanent';
}

/** Prefer ContactPersonNumber1 / legacy Contact Person Number column */
function primaryPhone(payload) {
  return cleanStr(payload.contact_person_number_1 ?? payload.contact_person_number);
}

class Customer {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH);
  }

  async findAll({ search = '', page = 1, limit = 200 }) {
    return new Promise((resolve, reject) => {
      const offset = (page - 1) * limit;
      const q = `%${String(search || '').trim()}%`;
      this.db.all(
        `SELECT *
         FROM customers
         WHERE (? = '%%')
            OR customer_number LIKE ?
            OR company_name LIKE ?
            OR city_name LIKE ?
            OR contact_person LIKE ?
            OR contact_person_number LIKE ?
            OR contact_person_number_1 LIKE ?
            OR second_name LIKE ?
            OR second_number LIKE ?
            OR email_1 LIKE ?
            OR second_email LIKE ?
         ORDER BY company_name ASC, id ASC
         LIMIT ? OFFSET ?`,
        [q, q, q, q, q, q, q, q, q, q, q, limit, offset],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  async findById(id) {
    return new Promise((resolve, reject) => {
      this.db.get('SELECT * FROM customers WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  /** Legacy: first row for this customer number */
  async findByCustomerNumber(customer_number) {
    const cn = cleanStr(customer_number);
    if (!cn) return null;
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM customers WHERE TRIM(customer_number) = ? ORDER BY id ASC LIMIT 1`,
        [cn],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async findAllByCustomerNumber(customer_number) {
    const cn = cleanStr(customer_number);
    if (!cn) return [];
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM customers WHERE TRIM(customer_number) = ? ORDER BY id ASC`,
        [cn],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows || []);
        }
      );
    });
  }

  async findDistinctCitiesByCustomerNumber(customer_number) {
    const cn = cleanStr(customer_number);
    if (!cn) return [];
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT DISTINCT TRIM(city_name) AS city_name
         FROM customers
         WHERE TRIM(customer_number) = ? AND TRIM(COALESCE(city_name, '')) != ''
         ORDER BY city_name COLLATE NOCASE ASC`,
        [cn],
        (err, rows) => {
          if (err) reject(err);
          else resolve((rows || []).map((r) => r.city_name));
        }
      );
    });
  }

  async findAddressesByCustomerNumber(customer_number, city_name = null) {
    const cn = cleanStr(customer_number);
    if (!cn) return [];
    const city = cleanStr(city_name);
    let sql = `SELECT * FROM customers WHERE TRIM(customer_number) = ?`;
    const params = [cn];
    if (city) {
      sql += ` AND TRIM(COALESCE(city_name,'')) = ?`;
      params.push(city);
    }
    sql += ` ORDER BY id ASC`;
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  }

  async findByNaturalKey(customer_number, city_name, address) {
    const cn = cleanStr(customer_number);
    const addr = cleanStr(address);
    if (!cn || !addr) return null;
    const city = cleanStr(city_name) || '';
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM customers
         WHERE TRIM(customer_number) = ?
           AND TRIM(COALESCE(city_name,'')) = ?
           AND TRIM(COALESCE(address,'')) = ?
         LIMIT 1`,
        [cn, city, addr],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  async findByCompanyName(company_name) {
    const name = cleanStr(company_name);
    if (!name) return null;
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM customers WHERE company_name = ? ORDER BY id ASC LIMIT 1`,
        [name],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  validate(payload) {
    const company_name = cleanStr(payload.company_name);
    const customer_number = cleanStr(payload.customer_number);
    if (!company_name) throw new Error('Company Name is required');
    if (!customer_number) throw new Error('Customer Number is required');
  }

  normalize(payload) {
    const phone = primaryPhone(payload);
    const desig2 = cleanStr(payload.designation_job_title_2 ?? payload.designation_job_2);
    return {
      customer_number: cleanStr(payload.customer_number),
      company_name: cleanStr(payload.company_name),
      city_name: cleanStr(payload.city_name),
      address: cleanStr(payload.address),
      gps: cleanStr(payload.gps),
      contact_person: cleanStr(payload.contact_person),
      contact_person_number: phone,
      contact_person_number_1: phone,
      email_1: cleanStr(payload.email_1),
      designation_job: cleanStr(payload.designation_job),
      second_name: cleanStr(payload.second_name),
      second_number: cleanStr(payload.second_number),
      second_email: cleanStr(payload.second_email),
      designation_job_2: desig2,
      designation_job_title_2: desig2,
      remarks: cleanStr(payload.remarks),
      address_type: normalizeAddressType(payload.address_type),
    };
  }

  async create(payload) {
    this.validate(payload);
    const p = this.normalize(payload);
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO customers (
          customer_number, company_name, city_name, address, gps,
          contact_person, contact_person_number, contact_person_number_1, email_1, designation_job,
          second_name, second_number, second_email, designation_job_2, designation_job_title_2, remarks,
          address_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          p.customer_number,
          p.company_name,
          p.city_name,
          p.address,
          p.gps,
          p.contact_person,
          p.contact_person_number,
          p.contact_person_number_1,
          p.email_1,
          p.designation_job,
          p.second_name,
          p.second_number,
          p.second_email,
          p.designation_job_2,
          p.designation_job_title_2,
          p.remarks,
          p.address_type,
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  }

  async updateById(id, payload) {
    this.validate(payload);
    const p = this.normalize(payload);
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE customers SET
          customer_number = ?,
          company_name = ?,
          city_name = ?,
          address = ?,
          gps = ?,
          contact_person = ?,
          contact_person_number = ?,
          contact_person_number_1 = ?,
          email_1 = ?,
          designation_job = ?,
          second_name = ?,
          second_number = ?,
          second_email = ?,
          designation_job_2 = ?,
          designation_job_title_2 = ?,
          remarks = ?,
          address_type = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          p.customer_number,
          p.company_name,
          p.city_name,
          p.address,
          p.gps,
          p.contact_person,
          p.contact_person_number,
          p.contact_person_number_1,
          p.email_1,
          p.designation_job,
          p.second_name,
          p.second_number,
          p.second_email,
          p.designation_job_2,
          p.designation_job_title_2,
          p.remarks,
          p.address_type,
          id,
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ id, changes: this.changes || 0 });
        }
      );
    });
  }

  async deleteById(id) {
    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM customers WHERE id = ?', [id], function (err) {
        if (err) reject(err);
        else resolve({ deleted: this.changes > 0 });
      });
    });
  }

  /**
   * Upsert by natural key (customer_number + city_name + address).
   * Fallbacks: customer_number only (first row), then company_name when customer_number blank.
   */
  async upsertByRules(payload) {
    this.validate(payload);
    const p = this.normalize(payload);

    let existing = null;
    if (p.customer_number && p.address) {
      existing = await this.findByNaturalKey(p.customer_number, p.city_name, p.address);
    } else if (p.customer_number && !p.address) {
      existing = await this.findByCustomerNumber(p.customer_number);
    }

    if (existing?.id) {
      await this.updateById(existing.id, p);
      return { id: existing.id, action: 'updated' };
    }

    const created = await this.create(p);
    return { id: created.id, action: 'created' };
  }

  close() {
    this.db.close();
  }
}

module.exports = Customer;
