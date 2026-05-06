const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { normalizePhone, normalizeTransportType, trimStr, DS } = require('../services/deliveryWorkflow');
const { parseLatLng } = require('../services/geo');

const router = express.Router();
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

async function loadUserPhone(uid) {
  const u = await dbGet(`SELECT mobile_number FROM users WHERE id = ?`, [uid]);
  return normalizePhone(u?.mobile_number);
}

async function canSeeTask(req, taskRow, dnRow) {
  const role = String(req.user.role || '').toLowerCase();
  if (role === 'admin') return true;
  const uid = Number(req.user.sub);
  if (!uid) return false;
  if (taskRow?.driver_user_id && Number(taskRow.driver_user_id) === uid) return true;
  const want = await loadUserPhone(uid);
  const got = normalizePhone(taskRow?.driver_mobile || dnRow?.driver_mobile);
  return Boolean(want && got && want === got);
}

function isActiveTask(taskRow) {
  const st = trimStr(taskRow?.status);
  if (!st) return false;
  return st !== DS.CLOSED;
}

function attachLatLng(row) {
  const lat = row?.latitude != null ? Number(row.latitude) : null;
  const lng = row?.longitude != null ? Number(row.longitude) : null;
  if (Number.isFinite(lat) && Number.isFinite(lng)) return row;
  const parsed = parseLatLng(row?.gps_link);
  if (!parsed) return row;
  return { ...row, latitude: parsed.latitude, longitude: parsed.longitude };
}

// GET /api/mobile/driver-deliveries/active
router.get('/active', async (req, res) => {
  try {
    const uid = Number(req.user.sub);
    const role = String(req.user.role || '').toLowerCase();
    const staff = role === 'admin' || req.user.permissions?.can_confirm_picked;

    const rows = await dbAll(
      `SELECT t.*, dn.transportation_type AS dn_transportation_type, dn.driver_mobile AS dn_driver_mobile,
              dn.is_closed AS dn_is_closed
       FROM driver_delivery_tasks t
       JOIN delivery_notes dn ON dn.id = t.dn_id
       ORDER BY t.id DESC`
    );

    const gapp = (rows || []).filter((r) => normalizeTransportType(r.dn_transportation_type) === 'GAPP');
    const active = gapp.filter((r) => isActiveTask(r) && Number(r.dn_is_closed || 0) !== 1);

    let out = active;
    if (!staff) {
      const phoneNorm = await loadUserPhone(uid);
      out = active.filter((t) => {
        if (t.driver_user_id && Number(t.driver_user_id) === uid) return true;
        const tm = normalizePhone(t.driver_mobile || t.dn_driver_mobile);
        return Boolean(phoneNorm && tm && phoneNorm === tm);
      });
    }

    const enriched = out.map((r) => attachLatLng(r));
    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/mobile/driver-deliveries/:taskId (active-only helper)
router.get('/task/:id', async (req, res) => {
  try {
    const tid = Number(req.params.id);
    if (!Number.isFinite(tid)) return res.status(400).json({ error: 'Invalid id' });
    const task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ?`, [tid]);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const dn = await dbGet(`SELECT * FROM delivery_notes WHERE id = ?`, [task.dn_id]);
    if (!dn || normalizeTransportType(dn.transportation_type) !== 'GAPP') {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (!isActiveTask(task) || Number(dn.is_closed || 0) === 1) return res.status(404).json({ error: 'Task not active' });
    if (!(await canSeeTask(req, task, dn))) return res.status(403).json({ error: 'Forbidden' });
    res.json(attachLatLng({ ...task, dn_is_closed: dn.is_closed }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

