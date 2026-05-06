const express = require('express');
const db = require('../db');
const { getStockComparison } = require('../services/stockComparisonService');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const filter = String(req.query.filter || 'all').toLowerCase();
    const searchPn = String(req.query.part_number || '').trim();
    const searchSap = String(req.query.sap_part_number || '').trim();

    const { rows } = await getStockComparison(db, {
      comparison_type: 'main_vs_rack',
      comparison_base: 'main_stock',
      storage_location: '1004_1007',
      status: filter === 'match' ? 'match' : filter === 'mismatch' ? 'mismatch' : 'all',
      search: '',
      search_part_number: searchPn,
      search_sap_part_number: searchSap,
    });

    res.json({ rows, filter: filter === 'match' || filter === 'mismatch' ? filter : 'all' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
