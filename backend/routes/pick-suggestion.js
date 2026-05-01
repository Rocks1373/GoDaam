const express = require('express');
const PickSuggestion = require('../models/PickSuggestion');

const router = express.Router();
const pickSuggestion = new PickSuggestion();

// POST /api/pick-suggestion/generate - Generate FIFO suggestions
router.post('/generate', async (req, res) => {
  try {
    const { outbound_number, part_number, required_qty } = req.body;
    
    if (!outbound_number || !part_number || !required_qty || required_qty <= 0) {
      return res.status(400).json({ 
        error: 'outbound_number, part_number, and required_qty are required' 
      });
    }

    const result = await pickSuggestion.generateSuggestions({
      outbound_number,
      part_number,
      required_qty: parseFloat(required_qty)
    });

    res.status(201).json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/pick-suggestion/:outbound_id - Get suggestions for outbound
router.get('/:outbound_id', async (req, res) => {
  try {
    const suggestions = await pickSuggestion.getByOutbound(req.params.outbound_id);
    res.json(suggestions);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/pick-suggestion/:id/confirm - Confirm pick (update stock)
router.put('/:id/confirm', async (req, res) => {
  try {
    const { picked_qty } = req.body;
    // TODO: Implement stock deduction logic
    res.json({ message: 'Pick confirmed', picked_qty });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
