/**
 * Authenticated file delivery for backend/uploads.
 *
 * Replaces the old `app.use('/uploads', express.static(...))` route which served
 * uploaded driver attachments, invoice scans, OCR images, etc. with no auth.
 *
 * Mount path: /api/files/uploads/*
 * Auth: requireAuth + requireWebAccess (mounted in server.js).
 *
 * Defends against:
 *   - Path traversal (`..`, absolute paths, NUL bytes, URL-encoded escapes)
 *   - Symlink escape (real path must remain inside the uploads root)
 *   - Hidden files (anything starting with a dot)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const UPLOADS_ROOT = path.resolve(path.join(__dirname, '..', 'uploads'));

function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return false;
  if (rel.includes('\0')) return false;
  if (rel.includes('..')) return false;
  // Disallow absolute Windows-style or POSIX paths in the relative segment.
  if (path.isAbsolute(rel)) return false;
  // Disallow hidden / dotfiles anywhere in the path.
  if (rel.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return false;
  return true;
}

router.get(/^\/(.+)$/, (req, res) => {
  const rel = req.params[0] || '';
  if (!isSafeRelativePath(rel)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  const candidate = path.resolve(UPLOADS_ROOT, rel);
  // candidate must live strictly inside the uploads root, even after symlink resolution.
  if (!candidate.startsWith(UPLOADS_ROOT + path.sep) && candidate !== UPLOADS_ROOT) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  fs.realpath(candidate, (err, real) => {
    if (err) return res.status(404).json({ error: 'Not found' });
    if (!real.startsWith(UPLOADS_ROOT + path.sep) && real !== UPLOADS_ROOT) {
      return res.status(400).json({ error: 'Invalid path' });
    }
    fs.stat(real, (statErr, stat) => {
      if (statErr || !stat.isFile()) return res.status(404).json({ error: 'Not found' });
      // Disable caching for sensitive content; rely on auth check on each request.
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.sendFile(real);
    });
  });
});

module.exports = router;
