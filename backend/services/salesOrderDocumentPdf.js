const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

/** POD mobile/upload accepts PDF, JPEG, or PNG only (WebP/HEIC etc. not embedded by pdf-lib). */
const ALLOWED_POD_INPUT_MIMES = new Set(['application/pdf', 'image/jpeg', 'image/png']);

/**
 * Move or convert a multer-saved POD file to a final `.pdf` path. Deletes the source file when appropriate.
 * @throws {Error} if mime type is not allowed or conversion fails
 */
async function finalizePodAsPdf(multerPath, mimeType, destPdfAbs) {
  const mt = String(mimeType || '').toLowerCase();
  if (!ALLOWED_POD_INPUT_MIMES.has(mt)) {
    throw new Error('POD must be a PDF, JPEG, or PNG file.');
  }
  if (mt === 'application/pdf') {
    await fs.promises.rename(multerPath, destPdfAbs);
    return destPdfAbs;
  }
  const prepared = await ensurePdfUploadPath(multerPath, mimeType, destPdfAbs);
  if (prepared.filePath !== multerPath) {
    await fs.promises.unlink(multerPath).catch(() => {});
  }
  return prepared.filePath;
}

/**
 * If input is an image, write a single-page PDF next to the source (same basename + .pdf).
 * Returns { filePath, mimeType } for upload (always PDF for images).
 */
async function ensurePdfUploadPath(originalPath, mimeType, targetPdfPath) {
  const mt = String(mimeType || '').toLowerCase();
  if (mt === 'application/pdf') {
    return { filePath: originalPath, mimeType: 'application/pdf' };
  }
  if (mt.startsWith('image/')) {
    const buf = await fs.promises.readFile(originalPath);
    const pdf = await PDFDocument.create();
    let img;
    if (mt.includes('png')) {
      img = await pdf.embedPng(buf);
    } else {
      img = await pdf.embedJpg(buf);
    }
    const page = pdf.addPage([img.width, img.height]);
    page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    const out = await pdf.save();
    await fs.promises.writeFile(targetPdfPath, out);
    return { filePath: targetPdfPath, mimeType: 'application/pdf' };
  }
  return { filePath: originalPath, mimeType: mimeType || 'application/octet-stream' };
}

module.exports = { ensurePdfUploadPath, finalizePodAsPdf, ALLOWED_POD_INPUT_MIMES };
