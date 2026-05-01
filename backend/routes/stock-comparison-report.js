const express = require('express');
const { promisify } = require('util');
const db = require('../db');

const router = express.Router();
const dbAll = promisify(db.all.bind(db));

const EPS = 1e-6;

router.get('/', async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all').toLowerCase();
    const searchPn = String(req.query.part_number || '').trim().toLowerCase();
    const searchSap = String(req.query.sap_part_number || '').trim().toLowerCase();

    const sql = `
      SELECT
        ms.part_number AS part_number,
        ms.sap_part_number AS sap_part_number,
        ms.description AS description,
        ms.available_qty AS main_stock_available_qty,
        COALESCE((
          SELECT SUM(sbr.available_qty)
          FROM stock_by_rack sbr
          WHERE sbr.part_number = ms.part_number
             OR (
               COALESCE(TRIM(ms.sap_part_number), '') != ''
               AND TRIM(COALESCE(sbr.sap_part_number, '')) = TRIM(ms.sap_part_number)
             )
        ), 0) AS stock_by_rack_available_qty,
        ms.sap_qty AS sap_qty,
        (
          ms.available_qty - COALESCE((
            SELECT SUM(sbr.available_qty)
            FROM stock_by_rack sbr
            WHERE sbr.part_number = ms.part_number
               OR (
                 COALESCE(TRIM(ms.sap_part_number), '') != ''
                 AND TRIM(COALESCE(sbr.sap_part_number, '')) = TRIM(ms.sap_part_number)
               )
          ), 0)
        ) AS difference,
        CASE
          WHEN ABS(
            ms.available_qty - COALESCE((
              SELECT SUM(sbr.available_qty)
              FROM stock_by_rack sbr
              WHERE sbr.part_number = ms.part_number
                 OR (
                   COALESCE(TRIM(ms.sap_part_number), '') != ''
                   AND TRIM(COALESCE(sbr.sap_part_number, '')) = TRIM(ms.sap_part_number)
                 )
            ), 0)
          ) <= ${EPS} THEN 'Match'
          ELSE 'Mismatch'
        END AS status
      FROM main_stock ms
      ORDER BY ms.part_number ASC
    `;

    let rows = await dbAll(sql);

    if (searchPn) {
      rows = rows.filter((r) => String(r.part_number || '').toLowerCase().includes(searchPn));
    }
    if (searchSap) {
      rows = rows.filter((r) => String(r.sap_part_number || '').toLowerCase().includes(searchSap));
    }

    if (filter === 'match') {
      rows = rows.filter((r) => Math.abs(Number(r.difference) || 0) <= EPS);
    } else if (filter === 'mismatch') {
      rows = rows.filter((r) => Math.abs(Number(r.difference) || 0) > EPS);
    }

    res.json({ rows, filter: filter === 'match' || filter === 'mismatch' ? filter : 'all' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
