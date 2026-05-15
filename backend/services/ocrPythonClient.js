/**
 * HTTP client for the standalone OCR service (FastAPI + Tesseract/PyMuPDF/pdfplumber).
 * Set OCR_PYTHON_SERVICE_URL (e.g. http://127.0.0.1:8090) on the Node backend.
 */
const fs = require('fs');
const path = require('path');

function getPythonOcrBaseUrl() {
  const u = process.env.OCR_PYTHON_SERVICE_URL || '';
  return String(u).trim().replace(/\/$/, '');
}

/**
 * Upload a local file to Python OCR, then run extract. Returns JSON including full_text.
 */
async function uploadAndExtract(absPath) {
  const base = getPythonOcrBaseUrl();
  if (!base) {
    const err = new Error(
      'OCR_PYTHON_SERVICE_URL is not set. Run your OCR HTTP service and point the backend at it, e.g. http://127.0.0.1:8090'
    );
    err.code = 'OCR_PYTHON_UNCONFIGURED';
    throw err;
  }

  const buf = fs.readFileSync(absPath);
  const name = path.basename(absPath) || 'upload.bin';

  const fd = new FormData();
  fd.append('file', new Blob([buf]), name);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);

  let res;
  try {
    res = await fetch(`${base}/api/ocr/upload`, { method: 'POST', body: fd, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OCR Python upload failed (${res.status}): ${t.slice(0, 500)}`);
  }

  const up = await res.json();
  const fileId = up.file_id || up.fileId;
  if (!fileId) throw new Error('OCR Python upload response missing file_id');

  const ctrl2 = new AbortController();
  const timer2 = setTimeout(() => ctrl2.abort(), 180000);
  try {
    res = await fetch(`${base}/api/ocr/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: ctrl2.signal,
    });
  } finally {
    clearTimeout(timer2);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OCR Python extract failed (${res.status}): ${t.slice(0, 500)}`);
  }

  return res.json();
}

/**
 * POST multipart field `image` — same contract as legacy /mobile/ocr/image (lines + raw).
 */
async function imageLines(buffer, filename = 'capture.jpg') {
  const base = getPythonOcrBaseUrl();
  if (!base) {
    const err = new Error(
      'OCR_PYTHON_SERVICE_URL is not set. Configure the backend with the OCR service base URL.'
    );
    err.code = 'OCR_PYTHON_UNCONFIGURED';
    throw err;
  }

  const fd = new FormData();
  fd.append('image', new Blob([buffer]), filename || 'capture.jpg');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  let res;
  try {
    res = await fetch(`${base}/api/ocr/image-lines`, { method: 'POST', body: fd, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OCR Python image-lines failed (${res.status}): ${t.slice(0, 500)}`);
  }

  return res.json();
}

module.exports = {
  getPythonOcrBaseUrl,
  uploadAndExtract,
  imageLines,
};
