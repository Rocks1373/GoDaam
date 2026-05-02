const express = require('express');
const multer = require('multer');
const { recognize } = require('tesseract.js');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

/**
 * POST multipart/form-data field `image` — returns recognized text lines (English).
 * Uses Tesseract on the server so Expo Go can OCR without native modules.
 */
router.post('/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing image (multipart field: image)' });
    }
    const { data } = await recognize(req.file.buffer, 'eng');
    const raw = data?.text || '';
    const lines = raw
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    res.json({ lines, raw });
  } catch (e) {
    console.error('[ocr]', e);
    res.status(500).json({ error: e.message || 'OCR failed' });
  }
});

module.exports = router;
