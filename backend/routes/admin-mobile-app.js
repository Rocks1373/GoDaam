const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

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

router.get('/', (req, res) => {
  try {
    const p = resolveApkPath();
    const embeddedApiBase = embeddedApiBaseForDisplay();
    if (!fs.existsSync(p)) {
      return res.json({
        available: false,
        embeddedApiBase,
        message: 'APK file not found on server. Build with scripts/build-godam-android-release-apk.sh and deploy the artifact.',
      });
    }
    const st = fs.statSync(p);
    return res.json({
      available: true,
      filename: path.basename(p),
      sizeBytes: st.size,
      updatedAt: st.mtime.toISOString(),
      embeddedApiBase,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Failed to read APK metadata' });
  }
});

router.get('/apk', (req, res) => {
  const p = resolveApkPath();
  if (!fs.existsSync(p)) {
    return res.status(404).json({
      error: 'APK not deployed',
      detail: 'Place the release APK at uploads/mobile/GoDam.apk or set MOBILE_APP_APK_PATH.',
    });
  }
  const name = path.basename(p);
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  return res.download(p, name);
});

module.exports = router;
