const express = require('express');
const multer = require('multer');
const { imageLines, uploadBufferAndExtract } = require('../services/ocrPythonClient');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

/**
 * POST multipart/form-data field `image` — returns recognized text lines (English).
 * Delegates to the HTTP OCR service (system Tesseract). Requires OCR_PYTHON_SERVICE_URL on the backend.
 */
router.post('/image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing image (multipart field: image)' });
    }
    const data = await imageLines(req.file.buffer, req.file.originalname || 'capture.jpg');
    const raw = data?.raw ?? '';
    const lines = Array.isArray(data?.lines)
      ? data.lines.map((s) => String(s).trim()).filter(Boolean)
      : String(raw)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
    res.json({ lines, raw });
  } catch (e) {
    console.error('[ocr]', e);
    const code = e.code === 'OCR_PYTHON_UNCONFIGURED' ? 503 : 500;
    res.status(code).json({ error: e.message || 'OCR failed' });
  }
});

router.post('/file', upload.single('file'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({ error: 'Missing file (multipart field: file)' });
    }
    const data = await uploadBufferAndExtract(req.file.buffer, req.file.originalname || 'upload.bin');
    const raw = data?.full_text || data?.raw || '';
    const lines = Array.isArray(data?.lines)
      ? data.lines.map((s) => String(s).trim()).filter(Boolean)
      : String(raw)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
    res.json({ ...data, lines, raw, full_text: raw });
  } catch (e) {
    console.error('[ocr:file]', e);
    const code = e.code === 'OCR_PYTHON_UNCONFIGURED' ? 503 : 500;
    res.status(code).json({ error: e.message || 'OCR failed' });
  }
});

module.exports = router;
