const express = require('express');
const StockByRackSummary = require('../models/StockByRackSummary');
const { requireAdmin } = require('../middleware/auth');
const { applyRackAdjustment } = require('../services/rackBalanceAdjustment');

const router = express.Router();
const stockByRackSummary = new StockByRackSummary();

// GET /api/stock-by-rack - Summary list with filters
router.get('/', async (req, res) => {
  try {
    const {
      part_number,
      sap_part_number,
      rack_location,
      search,
      available_only,
      limit = 200,
      offset = 0,
    } = req.query;

    const rows = await stockByRackSummary.list({
      part_number,
      sap_part_number,
      rack_location,
      search: search || '',
      available_only: available_only === 'true',
      limit: Number(limit) || 200,
      offset: Number(offset) || 0,
    });

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/stock-by-rack/adjust — Admin only. Apply ±qty to a rack row, optional first_entry_date (FIFO),
 * then regenerate FIFO for all open outbound orders.
 * Body: { stock_by_rack_id, delta_qty (e.g. +2 / -2), remarks?, first_entry_date? }
 */
router.post('/adjust', requireAdmin, async (req, res) => {
  try {
    const out = await applyRackAdjustment({
      stock_by_rack_id: req.body?.stock_by_rack_id,
      delta_qty: req.body?.delta_qty,
      remarks: req.body?.remarks,
      first_entry_date: req.body?.first_entry_date,
      userId: req.user?.sub,
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /api/stock-by-rack/search - alias endpoint (same as list)
router.get('/search', async (req, res) => {
  try {
    const rows = await stockByRackSummary.list({
      part_number: req.query.part_number,
      sap_part_number: req.query.sap_part_number,
      rack_location: req.query.rack_location,
      search: req.query.search || '',
      available_only: req.query.available_only === 'true',
      limit: Number(req.query.limit) || 200,
      offset: Number(req.query.offset) || 0,
    });
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
