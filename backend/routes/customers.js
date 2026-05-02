const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');

const Customer = require('../models/Customer');

const router = express.Router();
const customers = new Customer();
const upload = multer({ dest: 'uploads/' });

/** Full template column order (optional columns may be omitted from the uploaded file). */
const EXCEL_HEADERS = [
  'Customer Number',
  'Company Name',
  'City Name',
  'Address',
  'GPS',
  'Contact Person',
  'Contact Person Number',
  'Email 1',
  'Designation / Job',
  '2nd Name',
  '2nd Number',
  '2nd Email',
  'Designation / Job 2',
  'Remarks',
];

const REQUIRED_EXCEL_HEADERS = ['Customer Number', 'Company Name'];

function normalizeHeader(h) {
  return String(h || '').trim();
}

function mapExcelRowToCustomer(row, headerIndex) {
  const get = (name) => {
    const idx = headerIndex[name];
    if (idx === undefined || idx < 0) return undefined;
    return row[idx];
  };
  const cpnum = get('Contact Person Number');
  return {
    customer_number: get('Customer Number'),
    company_name: get('Company Name'),
    city_name: get('City Name'),
    address: get('Address'),
    gps: get('GPS'),
    contact_person: get('Contact Person'),
    contact_person_number: cpnum,
    contact_person_number_1: cpnum,
    email_1: get('Email 1'),
    designation_job: get('Designation / Job'),
    second_name: get('2nd Name'),
    second_number: get('2nd Number'),
    second_email: get('2nd Email'),
    designation_job_2: get('Designation / Job 2'),
    designation_job_title_2: get('Designation / Job 2'),
    remarks: get('Remarks'),
    address_type: 'permanent',
  };
}

function cleanCustomerNumberParam(p) {
  return String(p ?? '').trim();
}

// GET /api/customers/by-number/:customer_number/cities
router.get('/by-number/:customer_number/cities', async (req, res) => {
  try {
    const cn = cleanCustomerNumberParam(req.params.customer_number);
    if (!cn) return res.status(400).json({ error: 'customer_number is required' });
    const cities = await customers.findDistinctCitiesByCustomerNumber(cn);
    res.json({ customer_number: cn, cities });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/customers/by-number/:customer_number/addresses?city=
router.get('/by-number/:customer_number/addresses', async (req, res) => {
  try {
    const cn = cleanCustomerNumberParam(req.params.customer_number);
    if (!cn) return res.status(400).json({ error: 'customer_number is required' });
    const city = req.query.city != null ? String(req.query.city).trim() : '';
    const rows = await customers.findAddressesByCustomerNumber(cn, city || null);
    res.json({ customer_number: cn, city_filter: city || null, addresses: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/customers/by-number/:customer_number
router.get('/by-number/:customer_number', async (req, res) => {
  try {
    const cn = cleanCustomerNumberParam(req.params.customer_number);
    if (!cn) return res.status(400).json({ error: 'customer_number is required' });
    const rows = await customers.findAllByCustomerNumber(cn);
    res.json({ customer_number: cn, addresses: rows, found: rows.length > 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/customers?search=
router.get('/', async (req, res) => {
  try {
    const { search = '', page = 1, limit = 200 } = req.query;
    const rows = await customers.findAll({
      search,
      page: parseInt(page, 10),
      limit: parseInt(limit, 10),
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customers (create)
router.post('/', async (req, res) => {
  try {
    const created = await customers.create(req.body);
    const row = await customers.findById(created.id);
    res.status(201).json(row || created);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'Duplicate address for this Customer Number + City + Address combination.' });
    }
    res.status(400).json({ error: e.message });
  }
});

// PUT /api/customers/:id
router.put('/:id', async (req, res) => {
  try {
    const updated = await customers.updateById(req.params.id, req.body);
    if (!updated.changes) return res.status(404).json({ error: 'Customer not found' });
    res.json(updated);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/customers/:id
router.delete('/:id', async (req, res) => {
  try {
    const r = await customers.deleteById(req.params.id);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customers/bulk-paste
router.post('/bulk-paste', async (req, res) => {
  try {
    const { data } = req.body;
    if (!Array.isArray(data)) return res.status(400).json({ error: 'data must be an array' });
    const results = [];
    for (const row of data) {
      try {
        const r = await customers.upsertByRules(row);
        results.push(r);
      } catch (e) {
        results.push({ error: e.message, row });
      }
    }
    res.json({
      success: results.length - results.filter((r) => r.error).length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/customers/upload (xlsx/csv) - exact header parsing
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const wb = XLSX.readFile(req.file.path, { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
    const headerRow = (grid[0] || []).map(normalizeHeader);

    const headerIndex = {};
    for (const h of REQUIRED_EXCEL_HEADERS) {
      const idx = headerRow.indexOf(h);
      if (idx === -1) {
        return res.status(400).json({
          error: `Missing required column: "${h}". Only Customer Number and Company Name are required; other columns are optional.`,
          required_headers: REQUIRED_EXCEL_HEADERS,
          optional_headers: EXCEL_HEADERS.filter((x) => !REQUIRED_EXCEL_HEADERS.includes(x)),
          found_headers: headerRow,
        });
      }
      headerIndex[h] = idx;
    }
    for (const h of EXCEL_HEADERS) {
      if (REQUIRED_EXCEL_HEADERS.includes(h)) continue;
      const idx = headerRow.indexOf(h);
      if (idx !== -1) headerIndex[h] = idx;
    }

    const results = [];
    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      if (!row || row.every((c) => String(c ?? '').trim() === '')) continue;
      const payload = mapExcelRowToCustomer(row, headerIndex);
      try {
        const out = await customers.upsertByRules(payload);
        results.push(out);
      } catch (e) {
        results.push({ error: e.message, row: payload });
      }
    }

    res.json({
      success: results.length - results.filter((x) => x.error).length,
      total: results.length,
      results,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

