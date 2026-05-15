const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { handleSalesOrderDocumentUpload } = require('../lib/salesOrderDocumentUploadHandler');

const router = express.Router();

const TEMP_ROOT = path.join(__dirname, '..', 'uploads', 'sales-order-docs-temp');
if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });
const upload = multer({ dest: TEMP_ROOT, limits: { fileSize: 25 * 1024 * 1024 } });

router.post(
  '/sales-order-documents/upload',
  upload.single('file'),
  async (req, res) => {
    await handleSalesOrderDocumentUpload(req, res, { fromScannerAgent: true });
  }
);

module.exports = router;
