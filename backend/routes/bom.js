const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { promisify } = require('util');

const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { normalizeExcelRows } = require('../utils/excelDates');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const dbRun = promisify(db.run.bind(db));
const dbGet = promisify(db.get.bind(db));
const dbAll = promisify(db.all.bind(db));

function pick(row, ...names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

function truthyPhysical(v) {
  const s = String(v || '').trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes';
}

router.get('/', requireAdmin, async (_req, res) => {
  try {
    const sets = await dbAll(
      `SELECT s.*,
        (SELECT COUNT(1) FROM part_bom_children c WHERE c.bom_set_id = s.id) AS child_count
       FROM part_bom_sets s
       ORDER BY s.parent_part_number ASC`
    );
    res.json(sets);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/template', requireAdmin, (_req, res) => {
  try {
    const wb = XLSX.utils.book_new();
    const rows = [
      {
        'Parent Part Number': 'UPS-SET-001',
        'Parent SAP Part Number': 'UPSSET001',
        'Parent Description': 'UPS Complete Set',
        'Child Part Number': 'UPS-001',
        'Child SAP Part Number': 'UPS001',
        'Child Description': 'UPS Unit',
        'Child Qty Per Parent': 1,
        UOM: 'PCS',
        'Parent Is Physical': 'false',
      },
      {
        'Parent Part Number': 'UPS-SET-001',
        'Parent SAP Part Number': 'UPSSET001',
        'Parent Description': 'UPS Complete Set',
        'Child Part Number': 'BATTERY-001',
        'Child SAP Part Number': 'BAT001',
        'Child Description': 'External Battery',
        'Child Qty Per Parent': 1,
        UOM: 'PCS',
        'Parent Is Physical': 'false',
      },
      {
        'Parent Part Number': 'UPS-SET-001',
        'Parent SAP Part Number': 'UPSSET001',
        'Parent Description': 'UPS Complete Set',
        'Child Part Number': 'RAIL-KIT-001',
        'Child SAP Part Number': 'RAIL001',
        'Child Description': 'Rail Kit',
        'Child Qty Per Parent': 2,
        UOM: 'PCS',
        'Parent Is Physical': 'false',
      },
    ];
    const ws = XLSX.utils.json_to_sheet(rows);
    /* widen columns for readability */
    ws['!cols'] = [22, 22, 30, 22, 22, 30, 18, 8, 18].map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, 'BOM');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="bom_template.xlsx"');
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/** Search main_stock + stock_by_rack so the parent picker can show where a part exists. */
router.get('/search-stock', requireAdmin, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (!q || q.length < 1) return res.json([]);
    const like = `%${q}%`;
    const msRows = await dbAll(
      `SELECT part_number, sap_part_number, description, available_qty
       FROM main_stock
       WHERE part_number LIKE ? OR sap_part_number LIKE ? OR description LIKE ?
       ORDER BY part_number ASC LIMIT 40`,
      [like, like, like]
    );
    const rackParts = await dbAll(
      `SELECT DISTINCT part_number, sap_part_number, description, SUM(available_qty) AS rack_qty
       FROM stock_by_rack
       WHERE part_number LIKE ? OR sap_part_number LIKE ? OR description LIKE ?
       GROUP BY part_number, sap_part_number, description
       ORDER BY part_number ASC LIMIT 40`,
      [like, like, like]
    );
    /* Merge: annotate with where each part lives */
    const map = new Map();
    for (const r of msRows) {
      map.set(r.part_number.toUpperCase(), {
        part_number: r.part_number,
        sap_part_number: r.sap_part_number || '',
        description: r.description || '',
        in_main_stock: true,
        main_stock_qty: Number(r.available_qty) || 0,
        in_rack: false,
        rack_qty: 0,
      });
    }
    for (const r of rackParts) {
      const k = r.part_number.toUpperCase();
      if (map.has(k)) {
        map.get(k).in_rack = true;
        map.get(k).rack_qty = Number(r.rack_qty) || 0;
      } else {
        map.set(k, {
          part_number: r.part_number,
          sap_part_number: r.sap_part_number || '',
          description: r.description || '',
          in_main_stock: false,
          main_stock_qty: 0,
          in_rack: true,
          rack_qty: Number(r.rack_qty) || 0,
        });
      }
    }
    res.json([...map.values()].slice(0, 50));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const b = req.body || {};
    const parent_part_number = String(b.parent_part_number || '').trim();
    if (!parent_part_number) return res.status(400).json({ error: 'parent_part_number required' });
    const parent_sap_part_number = String(b.parent_sap_part_number || '').trim() || null;
    const parent_description = String(b.parent_description || '').trim() || null;
    const parent_is_physical = b.parent_is_physical ? 1 : 0;
    const is_active = b.is_active === false || b.is_active === 0 ? 0 : 1;
    const created_by = Number(req.user.sub) || null;
    await dbRun(
      `INSERT INTO part_bom_sets (parent_part_number, parent_sap_part_number, parent_description, parent_is_physical, is_active, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [parent_part_number, parent_sap_part_number, parent_description, parent_is_physical, is_active, created_by]
    );
    const row = await dbGet(`SELECT * FROM part_bom_sets WHERE LOWER(TRIM(parent_part_number)) = LOWER(TRIM(?))`, [
      parent_part_number,
    ]);
    res.status(201).json(row);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Parent part number already exists' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.post('/upload', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'file is required' });
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = normalizeExcelRows(XLSX.utils.sheet_to_json(sheet, { defval: '' }));
    if (!rows.length) return res.status(400).json({ error: 'Empty sheet' });

    const results = [];
    await dbRun('BEGIN IMMEDIATE');
    try {
      for (const [i, row] of rows.entries()) {
        const parentPn = String(pick(row, 'Parent Part Number', 'parent_part_number')).trim();
        if (!parentPn) {
          results.push({ ok: false, error: 'Parent Part Number is required', row_index: i + 1, row });
          continue;
        }
        const parentSap = String(pick(row, 'Parent SAP Part Number', 'parent_sap_part_number')).trim();
        const parentDesc = String(pick(row, 'Parent Description', 'parent_description')).trim();
        const childPn = String(pick(row, 'Child Part Number', 'child_part_number')).trim();
        if (!childPn) {
          results.push({ ok: false, error: 'Child Part Number is required', row_index: i + 1, row });
          continue;
        }
        const childSap = String(pick(row, 'Child SAP Part Number', 'child_sap_part_number')).trim();
        const childDesc = String(pick(row, 'Child Description', 'child_description')).trim();
        const q = Number(pick(row, 'Child Qty Per Parent', 'child_qty_per_parent'));
        const uom = String(pick(row, 'UOM', 'uom')).trim();
        const phys = truthyPhysical(pick(row, 'Parent Is Physical', 'parent_is_physical'));
        if (!Number.isFinite(q) || q <= 0) {
          results.push({ ok: false, error: 'Child Qty Per Parent must be > 0', row_index: i + 1, row });
          continue;
        }

        let setRow = await dbGet(
          `SELECT * FROM part_bom_sets WHERE LOWER(TRIM(parent_part_number)) = LOWER(TRIM(?))`,
          [parentPn]
        );
        if (!setRow) {
          await dbRun(
            `INSERT INTO part_bom_sets (parent_part_number, parent_sap_part_number, parent_description, parent_is_physical, is_active, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [parentPn, parentSap || null, parentDesc || null, phys ? 1 : 0, Number(req.user.sub) || null]
          );
          setRow = await dbGet(`SELECT * FROM part_bom_sets WHERE LOWER(TRIM(parent_part_number)) = LOWER(TRIM(?))`, [parentPn]);
        } else {
          await dbRun(
            `UPDATE part_bom_sets SET parent_sap_part_number = ?, parent_description = ?, parent_is_physical = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [parentSap || setRow.parent_sap_part_number, parentDesc || setRow.parent_description, phys ? 1 : 0, setRow.id]
          );
        }

        const existingChild = await dbGet(
          `SELECT id FROM part_bom_children WHERE bom_set_id = ? AND LOWER(TRIM(child_part_number)) = LOWER(TRIM(?))`,
          [setRow.id, childPn]
        );
        if (existingChild?.id) {
          await dbRun(
            `UPDATE part_bom_children SET child_sap_part_number = ?, child_description = ?, child_qty_per_parent = ?, uom = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
            [childSap || null, childDesc || null, q, uom || null, existingChild.id]
          );
        } else {
          await dbRun(
            `INSERT INTO part_bom_children (bom_set_id, parent_part_number, child_part_number, child_sap_part_number, child_description, child_qty_per_parent, uom, is_active, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
            [setRow.id, parentPn, childPn, childSap || null, childDesc || null, q, uom || null]
          );
        }
        results.push({ ok: true, row_index: i + 1, parent_part_number: parentPn, child_part_number: childPn });
      }
      await dbRun('COMMIT');
    } catch (e) {
      await dbRun('ROLLBACK').catch(() => {});
      throw e;
    }
    const success = results.filter((r) => r.ok).length;
    res.json({ ok: true, rows_processed: success, success, total: results.length, results });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const b = req.body || {};
    const parent_sap_part_number =
      b.parent_sap_part_number !== undefined ? String(b.parent_sap_part_number || '').trim() || null : undefined;
    const parent_description =
      b.parent_description !== undefined ? String(b.parent_description || '').trim() || null : undefined;
    const parent_is_physical = b.parent_is_physical !== undefined ? (b.parent_is_physical ? 1 : 0) : undefined;
    const is_active = b.is_active !== undefined ? (b.is_active ? 1 : 0) : undefined;
    const cur = await dbGet(`SELECT * FROM part_bom_sets WHERE id = ?`, [id]);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    const nextSap = parent_sap_part_number !== undefined ? parent_sap_part_number : cur.parent_sap_part_number;
    const nextDesc = parent_description !== undefined ? parent_description : cur.parent_description;
    const nextPhys = parent_is_physical !== undefined ? parent_is_physical : cur.parent_is_physical;
    const nextActive = is_active !== undefined ? is_active : cur.is_active;
    await dbRun(
      `UPDATE part_bom_sets SET
        parent_sap_part_number = ?,
        parent_description = ?,
        parent_is_physical = ?,
        is_active = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextSap, nextDesc, nextPhys, nextActive, id]
    );
    const row = await dbGet(`SELECT * FROM part_bom_sets WHERE id = ?`, [id]);
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    await dbRun(`DELETE FROM part_bom_sets WHERE id = ?`, [id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:id/children', requireAdmin, async (req, res) => {
  try {
    const bom_set_id = Number(req.params.id);
    const b = req.body || {};
    const child_part_number = String(b.child_part_number || '').trim();
    if (!bom_set_id || !child_part_number) return res.status(400).json({ error: 'bom set id and child_part_number required' });
    const q = Number(b.child_qty_per_parent);
    if (!Number.isFinite(q) || q <= 0) return res.status(400).json({ error: 'child_qty_per_parent must be > 0' });
    const setRow = await dbGet(`SELECT parent_part_number FROM part_bom_sets WHERE id = ?`, [bom_set_id]);
    if (!setRow) return res.status(404).json({ error: 'BOM set not found' });
    const child_sap_part_number = String(b.child_sap_part_number || '').trim() || null;
    const child_description = String(b.child_description || '').trim() || null;
    const uom = String(b.uom || '').trim() || null;
    const is_active = b.is_active === false || b.is_active === 0 ? 0 : 1;
    await dbRun(
      `INSERT INTO part_bom_children (bom_set_id, parent_part_number, child_part_number, child_sap_part_number, child_description, child_qty_per_parent, uom, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        bom_set_id,
        setRow.parent_part_number,
        child_part_number,
        child_sap_part_number,
        child_description,
        q,
        uom,
        is_active,
      ]
    );
    const row = await dbGet(
      `SELECT * FROM part_bom_children WHERE bom_set_id = ? AND LOWER(TRIM(child_part_number)) = LOWER(TRIM(?))`,
      [bom_set_id, child_part_number]
    );
    res.status(201).json(row);
  } catch (e) {
    if (String(e.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: 'Child already exists for this parent' });
    }
    res.status(400).json({ error: e.message });
  }
});

router.delete('/children/:childId', requireAdmin, async (req, res) => {
  try {
    const childId = Number(req.params.childId);
    if (!childId) return res.status(400).json({ error: 'Invalid id' });
    await dbRun(`DELETE FROM part_bom_children WHERE id = ?`, [childId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/:parentPart', requireAdmin, async (req, res) => {
  try {
    const parent = decodeURIComponent(String(req.params.parentPart || '').trim());
    if (!parent) return res.status(400).json({ error: 'parent part required' });
    const setRow = await dbGet(
      `SELECT * FROM part_bom_sets WHERE LOWER(TRIM(parent_part_number)) = LOWER(TRIM(?))`,
      [parent]
    );
    if (!setRow) return res.status(404).json({ error: 'BOM parent not found' });
    const children = await dbAll(
      `SELECT * FROM part_bom_children WHERE bom_set_id = ? ORDER BY id ASC`,
      [setRow.id]
    );
    res.json({ set: setRow, children });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
