const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { promisify } = require('util');

const db = require('../db');
const {
  DS,
  normalizeTransportType,
  normalizePhone,
  trimStr,
  dnIsLocked,
  relPathForUpload,
} = require('../services/deliveryWorkflow');
const { notifyWebDeliveryStaff } = require('../services/deliveryNotifications');
const { logAudit } = require('../services/auditLogger');
const { finalizePodAsPdf } = require('../services/salesOrderDocumentPdf');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));
const dbAll = promisify(db.all.bind(db));

const POD_DIR = path.join(__dirname, '..', 'uploads', 'pod');
if (!fs.existsSync(POD_DIR)) fs.mkdirSync(POD_DIR, { recursive: true });

const upload = multer({ dest: POD_DIR, limits: { fileSize: 15 * 1024 * 1024 } });

function requireDeliveryScreen(req, res, next) {
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin' || role === 'driver') return next();
  if (req.user.permissions?.can_confirm_picked) return next();
  return res.status(403).json({ error: 'Forbidden' });
}

router.use(requireDeliveryScreen);

async function loadUserPhone(uid) {
  const u = await dbGet(`SELECT mobile_number, full_name FROM users WHERE id = ?`, [uid]);
  return { phoneNorm: normalizePhone(u?.mobile_number), name: trimStr(u?.full_name) };
}

/** Driver may act if task.driver_user_id matches, or phone matches DN driver_mobile (when user row was not linked at confirm). Admins always. */
async function canMutateTask(req, task, dn) {
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin') return true;
  const uid = Number(req.user.sub);
  if (!uid) return false;
  if (task.driver_user_id && Number(task.driver_user_id) === uid) return true;
  const { phoneNorm } = await loadUserPhone(uid);
  const taskPhone = normalizePhone(task.driver_mobile || dn?.driver_mobile);
  return Boolean(phoneNorm && taskPhone && phoneNorm === taskPhone);
}

// GET /api/mobile/deliveries
router.get('/', async (req, res) => {
  try {
    const uid = Number(req.user.sub);
    const role = String(req.user.role || '').toLowerCase();
    const staff = role === 'admin' || req.user.permissions?.can_confirm_picked;

    const rows = await dbAll(
      `SELECT t.*, dn.transportation_type AS dn_transportation_type, dn.delivery_status AS dn_delivery_status,
              dn.outbound_number AS dn_outbound, dn.driver_mobile AS dn_driver_mobile
       FROM driver_delivery_tasks t
       JOIN delivery_notes dn ON dn.id = t.dn_id`
    );

    const filtered = (rows || []).filter((r) => normalizeTransportType(r.dn_transportation_type) === 'GAPP');

    let out = filtered;
    if (!staff) {
      const { phoneNorm } = await loadUserPhone(uid);
      out = filtered.filter((t) => {
        if (t.driver_user_id && Number(t.driver_user_id) === uid) return true;
        const tm = normalizePhone(t.driver_mobile || t.dn_driver_mobile);
        return Boolean(phoneNorm && tm && phoneNorm === tm);
      });
    }

    out.sort((a, b) => (b.id || 0) - (a.id || 0));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mobile/deliveries/:id  (task id)
router.get('/:id', async (req, res) => {
  try {
    const tid = Number(req.params.id);
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'Invalid id' });
    const task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]);
    if (!dn || normalizeTransportType(dn.transportation_type) !== 'GAPP') {
      return res.status(404).json({ error: 'Task not found' });
    }

    const role = String(req.user.role || '').toLowerCase();
    const staff = role === 'admin' || req.user.permissions?.can_confirm_picked;
    if (!staff && !(await canMutateTask(req, task, dn))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({
      task,
      delivery_note: dn,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mobile/deliveries/:id/open
router.post('/:id/open', async (req, res) => {
  try {
    const tid = Number(req.params.id);
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'Invalid id' });
    const task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]);
    if (!dn || dnIsLocked(dn)) return res.status(400).json({ error: 'DN locked or missing' });
    if (!(await canMutateTask(req, task, dn))) return res.status(403).json({ error: 'Forbidden' });

    const st = trimStr(task.status);
    if (st !== DS.CONFIRMED && st !== DS.DRIVER_ASSIGNED) {
      return res.status(400).json({ error: `Cannot open from status: ${st || 'unknown'}` });
    }

    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `UPDATE driver_delivery_tasks SET status = ?, opened_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [DS.OPENED, tid]
      );
      await dbRun(
        `UPDATE delivery_notes SET delivery_status = ?, driver_opened_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [DS.OPENED, task.dn_id]
      );
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    logAudit({
      warehouse_id: dn.warehouse_id,
      req,
      module_name: 'DELIVERY',
      action_type: 'DRIVER_OPENED',
      reference_type: 'delivery_note',
      reference_id: dn.id,
      reference_number: dn.outbound_number || null,
      status_before: st,
      status_after: DS.OPENED,
      new_value: { driver_delivery_task_id: tid },
    });

    const { name: selfName } = await loadUserPhone(Number(req.user.sub));
    const driverName = selfName || trimStr(task.driver_name);
    const ob = trimStr(dn.outbound_number);
    await notifyWebDeliveryStaff(
      `Outbound ${ob} opened by driver`,
      `${driverName} opened delivery for outbound ${ob}.`,
      { dn_id: dn.id, outbound_number: ob }
    );

    res.json({
      ok: true,
      task: await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]),
      delivery_note: await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mobile/deliveries/:id/confirm-pickup — sets pickup + out-for-delivery (single step)
router.post('/:id/confirm-pickup', async (req, res) => {
  try {
    const tid = Number(req.params.id);
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'Invalid id' });
    const task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]);
    if (!dn || dnIsLocked(dn)) return res.status(400).json({ error: 'DN locked or missing' });
    if (!(await canMutateTask(req, task, dn))) return res.status(403).json({ error: 'Forbidden' });

    const st = trimStr(task.status);
    if (st !== DS.OPENED) {
      return res.status(400).json({ error: `Confirm pickup requires status "${DS.OPENED}".` });
    }

    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `UPDATE driver_delivery_tasks SET
          status = ?,
          pickup_confirmed_at = CURRENT_TIMESTAMP,
          out_for_delivery_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.OUT, tid]
      );
      await dbRun(
        `UPDATE delivery_notes SET
          delivery_status = ?,
          pickup_confirmed_at = CURRENT_TIMESTAMP,
          out_for_delivery_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.OUT, task.dn_id]
      );
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    logAudit({
      warehouse_id: dn.warehouse_id,
      req,
      module_name: 'DELIVERY',
      action_type: 'PICKUP_CONFIRMED',
      reference_type: 'delivery_note',
      reference_id: dn.id,
      reference_number: dn.outbound_number || null,
      status_before: st,
      status_after: DS.OUT,
      new_value: { driver_delivery_task_id: tid },
    });

    const driverName = trimStr(task.driver_name);
    const ob = trimStr(dn.outbound_number);
    await notifyWebDeliveryStaff(
      `Outbound ${ob} picked up by ${driverName}`,
      `Outbound ${ob} is out for delivery.`,
      { dn_id: dn.id, outbound_number: ob }
    );

    res.json({
      ok: true,
      task: await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]),
      delivery_note: await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mobile/deliveries/:id/upload-pod
router.post('/:id/upload-pod', upload.single('file'), async (req, res) => {
  try {
    const tid = Number(req.params.id);
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'Invalid id' });
    if (!req.file) return res.status(400).json({ error: 'file is required (multipart field: file)' });

    const task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]);
    if (!dn || dnIsLocked(dn)) return res.status(400).json({ error: 'DN locked or missing' });
    if (!(await canMutateTask(req, task, dn))) return res.status(403).json({ error: 'Forbidden' });

    const st = trimStr(task.status);
    if (st !== DS.OUT) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: `POD requires status "${DS.OUT}" (out for delivery).` });
    }

    const destPdf = path.join(POD_DIR, `pod_${tid}_${Date.now()}.pdf`);
    try {
      await finalizePodAsPdf(req.file.path, req.file.mimetype, destPdf);
    } catch (convErr) {
      await fs.promises.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: String(convErr.message || convErr) });
    }
    const finalAbs = destPdf;
    const rel = relPathForUpload(finalAbs);

    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `UPDATE driver_delivery_tasks SET
          status = ?,
          pod_file_path = ?,
          pod_uploaded_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.POD, rel, tid]
      );
      await dbRun(
        `UPDATE delivery_notes SET
          delivery_status = ?,
          pod_file_path = ?,
          pod_uploaded_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.POD, rel, task.dn_id]
      );
      await dbRun('COMMIT');
    } catch (e) {
      fs.unlink(finalAbs, () => {});
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    logAudit({
      warehouse_id: dn.warehouse_id,
      req,
      module_name: 'DELIVERY',
      action_type: 'POD_UPLOADED',
      reference_type: 'delivery_note',
      reference_id: dn.id,
      reference_number: dn.outbound_number || null,
      status_before: st,
      status_after: DS.POD,
      new_value: {
        driver_delivery_task_id: tid,
        pod_rel: rel,
        original_filename: String(req.file?.originalname || '').slice(0, 240) || null,
      },
    });

    try {
      const { syncDriverPodFileToDrive } = require('../services/salesOrderDocumentsService');
      await syncDriverPodFileToDrive({
        dn,
        task,
        localAbsPath: finalAbs,
        originalName: req.file?.originalname,
        mimeType: 'application/pdf',
        userId: Number(req.user.sub),
      });
    } catch (e) {
      console.warn('[salesOrderDocuments] driver POD sync:', e.message);
    }

    const ob = trimStr(dn.outbound_number);
    await notifyWebDeliveryStaff(
      `POD uploaded for ${ob}`,
      `Proof of delivery uploaded for outbound ${ob}. Open Notifications → View POD, or Delivery Note → POD panel.`,
      {
        dn_id: dn.id,
        outbound_number: ob,
        type: 'pod_uploaded',
        channel: 'delivery_pod',
      }
    );

    res.json({
      ok: true,
      pod_file_path: rel,
      task: await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]),
      delivery_note: await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mobile/deliveries/:id/close
router.post('/:id/close', async (req, res) => {
  try {
    const tid = Number(req.params.id);
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'Invalid id' });
    const task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]);
    if (!dn || dnIsLocked(dn)) return res.status(400).json({ error: 'DN locked or missing' });
    if (!(await canMutateTask(req, task, dn))) return res.status(403).json({ error: 'Forbidden' });

    const st = trimStr(task.status);
    if (st !== DS.POD) {
      return res.status(400).json({ error: `Close requires POD uploaded (status "${DS.POD}").` });
    }
    if (!trimStr(task.pod_file_path || dn.pod_file_path)) {
      return res.status(400).json({ error: 'POD file missing.' });
    }

    const uid = Number(req.user.sub);
    await dbRun('BEGIN IMMEDIATE');
    try {
      await dbRun(
        `UPDATE driver_delivery_tasks SET
          status = ?,
          closed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.CLOSED, tid]
      );
      await dbRun(
        `UPDATE delivery_notes SET
          delivery_status = ?,
          is_closed = 1,
          closed_at = CURRENT_TIMESTAMP,
          closed_by = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [DS.CLOSED, Number.isFinite(uid) ? uid : null, task.dn_id]
      );
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    logAudit({
      warehouse_id: dn.warehouse_id,
      req,
      module_name: 'DELIVERY',
      action_type: 'DRIVER_CLOSED',
      reference_type: 'delivery_note',
      reference_id: dn.id,
      reference_number: dn.outbound_number || null,
      status_before: st,
      status_after: DS.CLOSED,
      new_value: {
        driver_delivery_task_id: tid,
        pod_rel: trimStr(task.pod_file_path || dn.pod_file_path || '') || null,
      },
    });

    const ob = trimStr(dn.outbound_number);
    const inv = trimStr(dn.invoice_number);
    await notifyWebDeliveryStaff(
      `Outbound ${ob} delivered and CLOSED`,
      `Outbound ${ob} / Invoice ${inv} delivered and closed.`,
      { dn_id: dn.id, outbound_number: ob, invoice_number: inv }
    );

    res.json({
      ok: true,
      task: await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]),
      delivery_note: await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
