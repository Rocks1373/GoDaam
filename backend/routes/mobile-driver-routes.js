const express = require('express');
const { promisify } = require('util');

const db = require('../db');
const { DS, trimStr, normalizeTransportType } = require('../services/deliveryWorkflow');
const { parseLatLng, nearestNeighborOrder } = require('../services/geo');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbRun = promisify(db.run.bind(db));

function isActiveTaskRow(r) {
  const st = trimStr(r?.status);
  if (!st) return false;
  return st !== DS.CLOSED;
}

function validCoord(n) {
  return Number.isFinite(n) && Math.abs(n) <= 180;
}

function asCoordPair(row) {
  const lat = row?.latitude != null ? Number(row.latitude) : NaN;
  const lng = row?.longitude != null ? Number(row.longitude) : NaN;
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { latitude: lat, longitude: lng };
  const parsed = parseLatLng(row?.gps_link);
  return parsed ? { latitude: parsed.latitude, longitude: parsed.longitude } : null;
}

async function getActiveDriverTasks(uid) {
  const rows = await dbAll(
    `SELECT t.*, dn.transportation_type AS dn_transportation_type, dn.is_closed AS dn_is_closed
     FROM driver_delivery_tasks t
     JOIN delivery_notes dn ON dn.id = t.dn_id
     WHERE COALESCE(t.driver_user_id, -1) = ?
     ORDER BY t.id DESC`,
    [uid]
  );
  const gapp = (rows || []).filter((r) => normalizeTransportType(r.dn_transportation_type) === 'GAPP');
  return gapp.filter((r) => isActiveTaskRow(r) && Number(r.dn_is_closed || 0) !== 1);
}

async function upsertStop(uid, t, seq, coords) {
  const now = 'CURRENT_TIMESTAMP';
  await dbRun(
    `INSERT INTO driver_route_stops (
      driver_user_id, driver_delivery_task_id, outbound_number, customer_name, city_name,
      gps_link, latitude, longitude, sequence_no, route_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', ${now}, ${now})
    ON CONFLICT(driver_user_id, driver_delivery_task_id) DO UPDATE SET
      outbound_number=excluded.outbound_number,
      customer_name=excluded.customer_name,
      city_name=excluded.city_name,
      gps_link=excluded.gps_link,
      latitude=excluded.latitude,
      longitude=excluded.longitude,
      sequence_no=excluded.sequence_no,
      route_status='Active',
      updated_at=${now}`,
    [
      uid,
      Number(t.id),
      trimStr(t.outbound_number) || null,
      trimStr(t.customer_name) || null,
      trimStr(t.city_name) || null,
      trimStr(t.gps_link) || null,
      coords?.latitude ?? null,
      coords?.longitude ?? null,
      seq,
    ]
  );
}

// GET /api/mobile/driver-routes/current
router.get('/current', async (req, res) => {
  try {
    const uid = Number(req.user.sub);
    if (!uid) return res.status(400).json({ error: 'Invalid user' });
    const rows = await dbAll(
      `SELECT *
       FROM driver_route_stops
       WHERE driver_user_id = ? AND route_status = 'Active'
       ORDER BY sequence_no ASC, id ASC`,
      [uid]
    );
    res.json(rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mobile/driver-routes/auto-sort
router.post('/auto-sort', async (req, res) => {
  try {
    const uid = Number(req.user.sub);
    if (!uid) return res.status(400).json({ error: 'Invalid user' });

    const inLat = req.body?.driver_latitude;
    const inLng = req.body?.driver_longitude;
    const driver_latitude = inLat != null ? Number(inLat) : NaN;
    const driver_longitude = inLng != null ? Number(inLng) : NaN;

    // Default warehouse location (Riyadh) if driver GPS not provided
    const origin = {
      latitude: validCoord(driver_latitude) ? driver_latitude : Number(process.env.WAREHOUSE_LAT || 24.7136),
      longitude: validCoord(driver_longitude) ? driver_longitude : Number(process.env.WAREHOUSE_LNG || 46.6753),
    };

    const tasks = await getActiveDriverTasks(uid);
    if (!tasks.length) return res.json({ stops: [], warning: null });

    const withCoords = [];
    const missing = [];
    for (const t of tasks) {
      const coords = asCoordPair(t);
      if (!coords) {
        missing.push(t);
        continue;
      }
      withCoords.push({ ...t, ...coords });
    }

    const ordered = nearestNeighborOrder(origin, withCoords);

    await dbRun('BEGIN IMMEDIATE');
    try {
      // Clear existing sequences for active tasks (so UI can validate "required")
      for (const t of tasks) {
        await dbRun(
          `UPDATE driver_delivery_tasks
           SET sequence_no = NULL,
               latitude = COALESCE(latitude, ?),
               longitude = COALESCE(longitude, ?),
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND driver_user_id = ?`,
          [asCoordPair(t)?.latitude ?? null, asCoordPair(t)?.longitude ?? null, Number(t.id), uid]
        );
      }

      let seq = 1;
      for (const t of ordered) {
        await dbRun(
          `UPDATE driver_delivery_tasks
           SET sequence_no = ?,
               latitude = ?,
               longitude = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND driver_user_id = ?`,
          [seq, t.latitude, t.longitude, Number(t.id), uid]
        );
        await upsertStop(uid, t, seq, { latitude: t.latitude, longitude: t.longitude });
        seq += 1;
      }

      // Mark stops for no-longer-active tasks as Inactive
      await dbRun(
        `UPDATE driver_route_stops
         SET route_status = 'Inactive', updated_at = CURRENT_TIMESTAMP
         WHERE driver_user_id = ?
           AND route_status = 'Active'
           AND driver_delivery_task_id NOT IN (${tasks.map(() => '?').join(',') || '-1'})`,
        [uid, ...tasks.map((t) => Number(t.id))]
      );

      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    const stops = await dbAll(
      `SELECT * FROM driver_route_stops
       WHERE driver_user_id = ? AND route_status = 'Active'
       ORDER BY sequence_no ASC, id ASC`,
      [uid]
    );

    const warning =
      missing.length > 0 ? 'Some deliveries have no GPS location and were not added to route.' : null;
    res.json({ stops: stops || [], warning, origin });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mobile/driver-routes/save-sequence
router.post('/save-sequence', async (req, res) => {
  try {
    const uid = Number(req.user.sub);
    if (!uid) return res.status(400).json({ error: 'Invalid user' });
    const stops = req.body?.stops;
    if (!Array.isArray(stops) || stops.length === 0) {
      return res.status(400).json({ error: 'stops array required' });
    }

    const seen = new Set();
    for (const s of stops) {
      const tid = Number(s?.driver_delivery_task_id);
      const seq = Number(s?.sequence_no);
      if (!Number.isFinite(tid) || !Number.isFinite(seq)) return res.status(400).json({ error: 'Invalid stops payload' });
      if (!(seq > 0)) return res.status(400).json({ error: 'sequence_no must be positive' });
      if (seen.has(seq)) return res.status(400).json({ error: 'sequence_no must be unique' });
      seen.add(seq);
    }

    const active = await getActiveDriverTasks(uid);
    const activeIds = new Set(active.map((t) => Number(t.id)));
    for (const s of stops) {
      const tid = Number(s.driver_delivery_task_id);
      if (!activeIds.has(tid)) return res.status(403).json({ error: 'Cannot update sequence for non-active task' });
    }

    await dbRun('BEGIN IMMEDIATE');
    try {
      for (const s of stops) {
        const tid = Number(s.driver_delivery_task_id);
        const seq = Number(s.sequence_no);
        const task = await dbGet(`SELECT * FROM driver_delivery_tasks WHERE id = ? AND driver_user_id = ?`, [tid, uid]);
        if (!task) throw new Error('Task not found');

        const coords = asCoordPair(task);
        await dbRun(
          `UPDATE driver_delivery_tasks SET
             sequence_no = ?,
             latitude = COALESCE(latitude, ?),
             longitude = COALESCE(longitude, ?),
             updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND driver_user_id = ?`,
          [seq, coords?.latitude ?? null, coords?.longitude ?? null, tid, uid]
        );
        await upsertStop(uid, task, seq, coords);
      }
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }

    const rows = await dbAll(
      `SELECT * FROM driver_route_stops
       WHERE driver_user_id = ? AND route_status = 'Active'
       ORDER BY sequence_no ASC, id ASC`,
      [uid]
    );
    res.json({ stops: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/mobile/driver-routes/open-url
// Convenience endpoint: returns URL parts for current active route based on saved sequence.
router.post('/open-url', async (req, res) => {
  try {
    const uid = Number(req.user.sub);
    if (!uid) return res.status(400).json({ error: 'Invalid user' });
    const rows = await dbAll(
      `SELECT * FROM driver_route_stops
       WHERE driver_user_id = ? AND route_status = 'Active'
       ORDER BY sequence_no ASC, id ASC`,
      [uid]
    );
    res.json({ stops: rows || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

