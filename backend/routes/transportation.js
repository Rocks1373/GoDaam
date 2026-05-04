const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { promisify } = require('util');
const XLSX = require('xlsx');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const db = require('../db');
const {
  normCarrierType,
  computeAutoWarning,
  legacyVehicleDisplay,
  CARRIER_TYPES,
  VEHICLE_TYPES,
  ATTACHMENT_TYPES,
  driverPdfBasename,
} = require('../services/transportationService');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

const UPLOAD_REL = 'uploads/transportation/drivers';
const UPLOAD_ABS = path.join(__dirname, '..', UPLOAD_REL);

function requireTransportView(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'admin') return next();
  const p = req.user?.permissions || {};
  if (p.can_view_transportation || p.can_manage_transportation) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

function requireTransportManage(req, res, next) {
  const role = String(req.user?.role || '').toLowerCase();
  if (role === 'admin') return next();
  if (req.user?.permissions?.can_manage_transportation) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

router.use(requireTransportView);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const id = String(req.params.driver_id || '').trim();
      const dir = path.join(UPLOAD_ABS, id);
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        return cb(e);
      }
      cb(null, dir);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '') || '';
      cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 9)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimetype);
    if (!ok) return cb(new Error('Only PDF, JPG, PNG allowed'));
    cb(null, true);
  },
});

function mapDriverRow(r) {
  const warning = computeAutoWarning(r) || (String(r.auto_warning || '').trim() ? r.auto_warning : '');
  const display = warning || 'OK';
  return {
    ...r,
    vehicle_display: legacyVehicleDisplay(r),
    warning: display,
    attachment_count: r.attachment_count ?? 0,
  };
}

function buildDriverListSql(whereClause, params) {
  return {
    sql: `
      SELECT d.*,
        (SELECT COUNT(1) FROM transportation_driver_attachments a WHERE a.driver_id = d.id) AS attachment_count
      FROM transportation_drivers d
      WHERE ${whereClause}
      ORDER BY d.carrier_type ASC, d.carrier_name ASC, d.driver_name ASC
    `,
    params,
  };
}

// --- Carriers ---
router.get('/carriers', async (req, res) => {
  try {
    const search = String(req.query.search || '').trim().toLowerCase();
    let rows = await dbAll(
      `SELECT * FROM transportation_carriers ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, carrier_type ASC, carrier_name ASC`
    );
    if (search) rows = rows.filter((r) => String(r.carrier_name || '').toLowerCase().includes(search));
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/carriers', requireTransportManage, async (req, res) => {
  try {
    const carrier_type = normCarrierType(req.body?.carrier_type);
    const carrier_name = String(req.body?.carrier_name || '').trim();
    const contact_person = String(req.body?.contact_person || '').trim() || null;
    const phone_number = String(req.body?.phone_number || '').trim() || null;
    const email = String(req.body?.email || '').trim() || null;
    const remarks = String(req.body?.remarks || '').trim() || null;
    let status = String(req.body?.status || 'Active').trim();
    if (status !== 'Active' && status !== 'Inactive') status = 'Active';

    if (!carrier_type) return res.status(400).json({ error: 'carrier_type is required' });
    if (!carrier_name) return res.status(400).json({ error: 'carrier_name is required' });
    if (!CARRIER_TYPES.includes(carrier_type)) return res.status(400).json({ error: 'Invalid carrier_type' });

    await dbRun(
      `INSERT INTO transportation_carriers (carrier_type, carrier_name, contact_person, phone_number, email, remarks, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [carrier_type, carrier_name, contact_person, phone_number, email, remarks, status]
    );
    const row = await dbGet(`SELECT * FROM transportation_carriers WHERE id = last_insert_rowid()`);
    res.status(201).json(row);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/carriers/:id', requireTransportManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Carrier not found' });

    const carrier_type =
      req.body?.carrier_type !== undefined ? normCarrierType(req.body.carrier_type) : existing.carrier_type;
    const carrier_name =
      req.body?.carrier_name !== undefined ? String(req.body.carrier_name || '').trim() : existing.carrier_name;
    const contact_person =
      req.body?.contact_person !== undefined ? String(req.body.contact_person || '').trim() || null : existing.contact_person;
    const phone_number =
      req.body?.phone_number !== undefined ? String(req.body.phone_number || '').trim() || null : existing.phone_number;
    const email = req.body?.email !== undefined ? String(req.body.email || '').trim() || null : existing.email;
    const remarks = req.body?.remarks !== undefined ? String(req.body.remarks || '').trim() || null : existing.remarks;
    let status = req.body?.status !== undefined ? String(req.body.status || '').trim() : existing.status;
    if (status !== 'Active' && status !== 'Inactive') status = existing.status;

    if (!carrier_type) return res.status(400).json({ error: 'carrier_type is required' });
    if (!carrier_name) return res.status(400).json({ error: 'carrier_name is required' });
    if (!CARRIER_TYPES.includes(carrier_type)) return res.status(400).json({ error: 'Invalid carrier_type' });

    await dbRun(
      `UPDATE transportation_carriers SET carrier_type=?, carrier_name=?, contact_person=?, phone_number=?, email=?, remarks=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [carrier_type, carrier_name, contact_person, phone_number, email, remarks, status, id]
    );
    await dbRun(
      `UPDATE transportation_drivers SET carrier_type=?, carrier_name=?, updated_at=CURRENT_TIMESTAMP WHERE carrier_id=?`,
      [carrier_type, carrier_name, id]
    );
    res.json(await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [id]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function deleteAttachmentFilesForDriver(driverId) {
  const rows = await dbAll(`SELECT file_path FROM transportation_driver_attachments WHERE driver_id = ?`, [driverId]);
  for (const r of rows) {
    const fp = path.join(__dirname, '..', String(r.file_path || '').replace(/^\//, ''));
    try {
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
      // ignore
    }
  }
}

router.delete('/carriers/:id', requireTransportManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const drivers = await dbAll(`SELECT id FROM transportation_drivers WHERE carrier_id = ?`, [id]);
    for (const d of drivers) {
      await deleteAttachmentFilesForDriver(d.id);
      await dbRun(`DELETE FROM transportation_driver_attachments WHERE driver_id = ?`, [d.id]);
      await dbRun(`DELETE FROM transportation_drivers WHERE id = ?`, [d.id]);
    }
    const r = await dbRun(`DELETE FROM transportation_carriers WHERE id = ?`, [id]);
    res.json({ ok: true, deleted: r?.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/carriers/:carrier_id/drivers', async (req, res) => {
  try {
    const carrier_id = Number(req.params.carrier_id);
    if (!Number.isFinite(carrier_id)) return res.status(400).json({ error: 'Invalid carrier_id' });
    const rows = await dbAll(
      `SELECT * FROM transportation_drivers WHERE carrier_id = ? ORDER BY CASE status WHEN 'Active' THEN 0 ELSE 1 END, driver_name ASC`,
      [carrier_id]
    );
    res.json(rows.map((r) => mapDriverRow(r)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Drivers export (before :id routes) ---
router.get('/drivers/export/excel', requireTransportView, async (req, res) => {
  try {
    const { sql, params } = driverFilterQuery(req.query);
    const rows = await dbAll(sql, params);
    const sheetRows = rows.map((r) => {
      const w = computeAutoWarning(r) || '';
      return {
        'Carrier Type': r.carrier_type,
        'Carrier Name': r.carrier_name,
        'Driver Name': r.driver_name,
        'Driver Phone': r.driver_phone,
        'Iqama Number': r.iqama_number || '',
        'Iqama Expiry': r.iqama_expiry || '',
        'License Number': r.license_number || '',
        'License Expiry': r.license_expiry || '',
        'National ID': r.national_id || '',
        'Vehicle Number': r.vehicle_number || '',
        'Vehicle Type': r.vehicle_type || '',
        'Vehicle Document Number': r.vehicle_document_number || '',
        'Vehicle Document Expiry': r.vehicle_document_expiry || '',
        'Insurance Number': r.insurance_number || '',
        'Insurance Expiry': r.insurance_expiry || '',
        'Fahas Number': r.fahas_number || '',
        'Fahas Expiry': r.fahas_expiry || '',
        Status: r.status,
        Warning: w || 'OK',
        Remarks: r.remarks || '',
      };
    });
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(sheetRows.length ? sheetRows : [{}]);
    XLSX.utils.book_append_sheet(wb, ws, 'Drivers');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="driver-details.xlsx"');
    res.send(Buffer.from(buf));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function driverFilterQuery(q) {
  const cond = ['1=1'];
  const params = [];
  if (String(q.carrier_type || '').trim()) {
    cond.push('d.carrier_type = ?');
    params.push(normCarrierType(q.carrier_type));
  }
  if (String(q.carrier_name || '').trim()) {
    cond.push('LOWER(d.carrier_name) LIKE ?');
    params.push(`%${String(q.carrier_name).trim().toLowerCase()}%`);
  }
  if (String(q.driver_name || '').trim()) {
    cond.push('LOWER(d.driver_name) LIKE ?');
    params.push(`%${String(q.driver_name).trim().toLowerCase()}%`);
  }
  if (String(q.driver_phone || '').trim()) {
    cond.push('d.driver_phone LIKE ?');
    params.push(`%${String(q.driver_phone).trim()}%`);
  }
  if (String(q.vehicle_number || '').trim()) {
    cond.push('LOWER(d.vehicle_number) LIKE ?');
    params.push(`%${String(q.vehicle_number).trim().toLowerCase()}%`);
  }
  if (String(q.vehicle_type || '').trim()) {
    cond.push('d.vehicle_type = ?');
    params.push(String(q.vehicle_type).trim());
  }
  if (String(q.status || '').trim()) {
    cond.push('d.status = ?');
    params.push(String(q.status).trim());
  }
  const where = cond.join(' AND ');
  const { sql, params: p2 } = buildDriverListSql(where, params);
  return { sql, params: p2 };
}

function rowMatchesExpiryFilter(r, expiredOnly, expiringSoon) {
  const w = computeAutoWarning(r);
  if (!w) return false;
  const low = w.toLowerCase();
  const hasExp = low.includes('expired');
  const hasSoon = low.includes('expiring soon');
  if (expiredOnly && expiringSoon) return hasExp || hasSoon;
  if (expiredOnly) return hasExp;
  if (expiringSoon) return hasSoon;
  return true;
}

router.get('/drivers', async (req, res) => {
  try {
    const { sql, params } = driverFilterQuery(req.query);
    let rows = await dbAll(sql, params);
    const expiredOnly = String(req.query.expired_documents || '') === '1' || String(req.query.expired_only || '') === '1';
    const expiringSoon = String(req.query.expiring_soon || '') === '1';
    if (expiredOnly || expiringSoon) {
      rows = rows.filter((r) => rowMatchesExpiryFilter(r, expiredOnly, expiringSoon));
    }
    res.json(rows.map((r) => mapDriverRow(r)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/drivers/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await dbGet(`SELECT * FROM transportation_drivers WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Driver not found' });
    const attachments = await dbAll(
      `SELECT id, driver_id, attachment_type, file_name, file_path, file_mime_type, uploaded_at, uploaded_by
       FROM transportation_driver_attachments WHERE driver_id = ? ORDER BY uploaded_at DESC`,
      [id]
    );
    res.json({ ...mapDriverRow(row), attachments });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function readDriverBody(body, existing) {
  const e = existing == null ? {} : existing;
  const carrier_id = body?.carrier_id != null ? Number(body.carrier_id) : e.carrier_id;
  const driver_name = body?.driver_name !== undefined ? String(body.driver_name || '').trim() : e.driver_name;
  const driver_phone = body?.driver_phone !== undefined ? String(body.driver_phone || '').trim() : e.driver_phone;
  const opt = (k, def = null) => (body[k] !== undefined ? (String(body[k] || '').trim() || null) : e[k] ?? def);
  return {
    carrier_id,
    driver_name,
    driver_phone,
    iqama_number: opt('iqama_number'),
    iqama_expiry: opt('iqama_expiry'),
    license_number: opt('license_number'),
    license_expiry: opt('license_expiry'),
    national_id: opt('national_id'),
    vehicle_number: opt('vehicle_number'),
    vehicle_type: opt('vehicle_type'),
    vehicle_document_number: opt('vehicle_document_number'),
    vehicle_document_expiry: opt('vehicle_document_expiry'),
    insurance_number: opt('insurance_number'),
    insurance_expiry: opt('insurance_expiry'),
    fahas_number: opt('fahas_number'),
    fahas_expiry: opt('fahas_expiry'),
    remarks: opt('remarks'),
    status: (() => {
      const s = body?.status !== undefined ? String(body.status || '').trim() : e.status;
      return s === 'Inactive' ? 'Inactive' : 'Active';
    })(),
  };
}

router.post('/drivers', requireTransportManage, async (req, res) => {
  try {
    const data = readDriverBody(req.body, null);
    if (!Number.isFinite(data.carrier_id)) return res.status(400).json({ error: 'carrier_id is required' });
    if (!data.driver_name) return res.status(400).json({ error: 'driver_name is required' });
    if (!data.driver_phone) return res.status(400).json({ error: 'driver_phone is required' });
    const c = await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [data.carrier_id]);
    if (!c) return res.status(400).json({ error: 'Carrier not found' });
    if (data.vehicle_type && !VEHICLE_TYPES.includes(String(data.vehicle_type))) {
      return res.status(400).json({ error: 'Invalid vehicle_type' });
    }
    const draft = {
      ...data,
      carrier_type: c.carrier_type,
      carrier_name: c.carrier_name,
    };
    const auto_warning = computeAutoWarning(draft);
    await dbRun(
      `INSERT INTO transportation_drivers (
        carrier_id, carrier_type, carrier_name, driver_name, driver_phone,
        iqama_number, iqama_expiry, license_number, license_expiry, national_id,
        vehicle_number, vehicle_type, vehicle_document_number, vehicle_document_expiry,
        insurance_number, insurance_expiry, fahas_number, fahas_expiry,
        remarks, status, auto_warning, created_at, updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      [
        data.carrier_id,
        c.carrier_type,
        c.carrier_name,
        data.driver_name,
        data.driver_phone,
        data.iqama_number,
        data.iqama_expiry,
        data.license_number,
        data.license_expiry,
        data.national_id,
        data.vehicle_number,
        data.vehicle_type,
        data.vehicle_document_number,
        data.vehicle_document_expiry,
        data.insurance_number,
        data.insurance_expiry,
        data.fahas_number,
        data.fahas_expiry,
        data.remarks,
        data.status,
        auto_warning,
      ]
    );
    const row = await dbGet(`SELECT * FROM transportation_drivers WHERE id = last_insert_rowid()`);
    res.status(201).json(mapDriverRow(row));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/drivers/:id', requireTransportManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const existing = await dbGet(`SELECT * FROM transportation_drivers WHERE id = ?`, [id]);
    if (!existing) return res.status(404).json({ error: 'Driver not found' });
    const data = readDriverBody(req.body, existing);
    if (!Number.isFinite(data.carrier_id)) return res.status(400).json({ error: 'carrier_id is required' });
    if (!data.driver_name) return res.status(400).json({ error: 'driver_name is required' });
    if (!data.driver_phone) return res.status(400).json({ error: 'driver_phone is required' });
    const c = await dbGet(`SELECT * FROM transportation_carriers WHERE id = ?`, [data.carrier_id]);
    if (!c) return res.status(400).json({ error: 'Carrier not found' });
    if (data.vehicle_type && !VEHICLE_TYPES.includes(String(data.vehicle_type))) {
      return res.status(400).json({ error: 'Invalid vehicle_type' });
    }
    const draft = { ...data, carrier_type: c.carrier_type, carrier_name: c.carrier_name };
    const auto_warning = computeAutoWarning(draft);
    await dbRun(
      `UPDATE transportation_drivers SET
        carrier_id=?, carrier_type=?, carrier_name=?, driver_name=?, driver_phone=?,
        iqama_number=?, iqama_expiry=?, license_number=?, license_expiry=?, national_id=?,
        vehicle_number=?, vehicle_type=?, vehicle_document_number=?, vehicle_document_expiry=?,
        insurance_number=?, insurance_expiry=?, fahas_number=?, fahas_expiry=?,
        remarks=?, status=?, auto_warning=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`,
      [
        data.carrier_id,
        c.carrier_type,
        c.carrier_name,
        data.driver_name,
        data.driver_phone,
        data.iqama_number,
        data.iqama_expiry,
        data.license_number,
        data.license_expiry,
        data.national_id,
        data.vehicle_number,
        data.vehicle_type,
        data.vehicle_document_number,
        data.vehicle_document_expiry,
        data.insurance_number,
        data.insurance_expiry,
        data.fahas_number,
        data.fahas_expiry,
        data.remarks,
        data.status,
        auto_warning,
        id,
      ]
    );
    res.json(mapDriverRow(await dbGet(`SELECT * FROM transportation_drivers WHERE id = ?`, [id])));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/drivers/:id', requireTransportManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    await deleteAttachmentFilesForDriver(id);
    await dbRun(`DELETE FROM transportation_driver_attachments WHERE driver_id = ?`, [id]);
    const r = await dbRun(`DELETE FROM transportation_drivers WHERE id = ?`, [id]);
    res.json({ ok: true, deleted: r?.changes || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/drivers/:driver_id/attachments', requireTransportManage, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || String(err) });
    try {
      const driver_id = Number(req.params.driver_id);
      if (!Number.isFinite(driver_id)) return res.status(400).json({ error: 'Invalid driver_id' });
      const d = await dbGet(`SELECT id FROM transportation_drivers WHERE id = ?`, [driver_id]);
      if (!d) return res.status(404).json({ error: 'Driver not found' });
      const attachment_type = String(req.body?.attachment_type || '').trim();
      if (!ATTACHMENT_TYPES.includes(attachment_type)) {
        return res.status(400).json({ error: 'Invalid attachment_type' });
      }
      if (!req.file) return res.status(400).json({ error: 'file is required' });
      const rel = path.join(UPLOAD_REL, String(driver_id), req.file.filename).replace(/\\/g, '/');
      await dbRun(
        `INSERT INTO transportation_driver_attachments (driver_id, attachment_type, file_name, file_path, file_mime_type, uploaded_at, uploaded_by)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
        [driver_id, attachment_type, req.file.originalname || req.file.filename, rel, req.file.mimetype, req.user.sub]
      );
      const row = await dbGet(`SELECT * FROM transportation_driver_attachments WHERE id = last_insert_rowid()`);
      res.status(201).json(row);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

router.get('/drivers/:driver_id/attachments', async (req, res) => {
  try {
    const driver_id = Number(req.params.driver_id);
    if (!Number.isFinite(driver_id)) return res.status(400).json({ error: 'Invalid driver_id' });
    const rows = await dbAll(
      `SELECT * FROM transportation_driver_attachments WHERE driver_id = ? ORDER BY uploaded_at DESC`,
      [driver_id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/attachments/:id/download', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await dbGet(`SELECT * FROM transportation_driver_attachments WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const abs = path.join(__dirname, '..', String(row.file_path).replace(/^\//, ''));
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'File missing' });
    res.download(abs, row.file_name || 'attachment');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/attachments/:id', requireTransportManage, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid id' });
    const row = await dbGet(`SELECT * FROM transportation_driver_attachments WHERE id = ?`, [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const abs = path.join(__dirname, '..', String(row.file_path).replace(/^\//, ''));
    try {
      if (fs.existsSync(abs)) fs.unlinkSync(abs);
    } catch {
      // ignore
    }
    await dbRun(`DELETE FROM transportation_driver_attachments WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/drivers/:driver_id/export/pdf', requireTransportManage, async (req, res) => {
  try {
    const driver_id = Number(req.params.driver_id);
    if (!Number.isFinite(driver_id)) return res.status(400).json({ error: 'Invalid driver_id' });
    const d = await dbGet(`SELECT * FROM transportation_drivers WHERE id = ?`, [driver_id]);
    if (!d) return res.status(404).json({ error: 'Driver not found' });
    const attachments = await dbAll(`SELECT * FROM transportation_driver_attachments WHERE driver_id = ? ORDER BY uploaded_at ASC`, [
      driver_id,
    ]);
    const merged = await PDFDocument.create();
    const font = await merged.embedFont(StandardFonts.Helvetica);
    const cover = merged.addPage([595.28, 841.89]);
    const warn = computeAutoWarning(d) || 'None';
    const lines = [
      'Transportation Driver Documents',
      '',
      `Carrier: ${d.carrier_name || ''} (${d.carrier_type || ''})`,
      `Driver Name: ${d.driver_name || ''}`,
      `Phone: ${d.driver_phone || ''}`,
      `Vehicle Number: ${d.vehicle_number || ''}`,
      `Vehicle Type: ${d.vehicle_type || ''}`,
      '',
      `Warnings: ${warn}`,
    ];
    let y = 780;
    for (const line of lines) {
      cover.drawText(line, { x: 50, y, size: line.startsWith('Transportation') ? 16 : 11, font, color: rgb(0, 0, 0) });
      y -= line ? 22 : 12;
    }

    for (const att of attachments) {
      const abs = path.join(__dirname, '..', String(att.file_path).replace(/^\//, ''));
      if (!fs.existsSync(abs)) continue;
      const buf = fs.readFileSync(abs);
      const mime = String(att.file_mime_type || '');
      try {
        if (mime === 'application/pdf') {
          const src = await PDFDocument.load(buf);
          const copied = await merged.copyPages(src, src.getPageIndices());
          copied.forEach((p) => merged.addPage(p));
        } else if (mime === 'image/jpeg' || mime === 'image/png') {
          let img;
          if (mime === 'image/png') img = await merged.embedPng(buf);
          else img = await merged.embedJpg(buf);
          const page = merged.addPage([595.28, 841.89]);
          const iw = img.width;
          const ih = img.height;
          const maxW = 520;
          const maxH = 750;
          const scale = Math.min(maxW / iw, maxH / ih, 1);
          const w = iw * scale;
          const h = ih * scale;
          page.drawImage(img, { x: (595.28 - w) / 2, y: (841.89 - h) / 2, width: w, height: h });
        }
      } catch (e) {
        console.error('PDF merge skip attachment', att.id, e.message);
      }
    }

    const out = await merged.save();
    const fname = driverPdfBasename(d);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    res.send(Buffer.from(out));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
