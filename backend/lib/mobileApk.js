const fs = require('fs');
const path = require('path');

function resolveApkPath() {
  const custom = process.env.MOBILE_APP_APK_PATH && String(process.env.MOBILE_APP_APK_PATH).trim();
  if (custom) {
    return path.isAbsolute(custom) ? custom : path.resolve(__dirname, '..', custom);
  }
  return path.resolve(__dirname, '..', 'uploads', 'mobile', 'GoDam.apk');
}

function embeddedApiBaseForDisplay() {
  const raw =
    process.env.MOBILE_APP_EMBEDDED_API_BASE ||
    process.env.EXPO_PUBLIC_API_URL ||
    process.env.PUBLIC_API_ORIGIN ||
    '';
  const t = String(raw).trim().replace(/\/+$/, '');
  if (!t) return '';
  if (/\/api$/i.test(t)) return t;
  try {
    const u = new URL(t.includes('://') ? t : `https://${t}`);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return `${u.origin}/api`;
  } catch {
    return '';
  }
}

function getApkMetadataJson() {
  const p = resolveApkPath();
  const embeddedApiBase = embeddedApiBaseForDisplay();
  if (!fs.existsSync(p)) {
    return {
      available: false,
      embeddedApiBase,
      message:
        'APK file not found on server. Build with scripts/build-android-apk.sh, place GoDam.apk under uploads/mobile/, then redeploy.',
    };
  }
  const st = fs.statSync(p);
  return {
    available: true,
    filename: path.basename(p),
    sizeBytes: st.size,
    updatedAt: st.mtime.toISOString(),
    embeddedApiBase,
  };
}

function sendApkMetadata(req, res) {
  try {
    return res.json(getApkMetadataJson());
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to read APK metadata' });
  }
}

function sendApkDownload(req, res) {
  const p = resolveApkPath();
  if (!fs.existsSync(p)) {
    return res.status(404).json({
      error: 'APK not deployed',
      detail: 'Place the release APK at uploads/mobile/GoDam.apk or set MOBILE_APP_APK_PATH.',
    });
  }
  const abs = path.resolve(p);
  const name = path.basename(abs);
  const safeName = name.replace(/["\\]/g, '_');

  /* Binary download: use sendFile (explicit length + stream). Avoids edge cases with
     res.download + proxies where clients receive truncated or cached HTML as "APK". */
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  /* nginx: stream without buffering the whole ~90MB file to disk (reduces corrupt installs on mobile). */
  res.setHeader('X-Accel-Buffering', 'no');

  res.sendFile(abs, { etag: false, lastModified: false, dotfiles: 'deny' }, (err) => {
    if (!err) return;
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to send APK', detail: err.message || String(err) });
    }
  });
}

module.exports = {
  resolveApkPath,
  embeddedApiBaseForDisplay,
  getApkMetadataJson,
  sendApkMetadata,
  sendApkDownload,
};
