/**
 * Public APK metadata + download (no auth). Staff: GET /api/mobile-app and /api/mobile-app/apk
 */
const express = require('express');
const { sendApkMetadata, sendApkDownload } = require('../lib/mobileApk');

const router = express.Router();
router.get('/', sendApkMetadata);
router.get('/apk', sendApkDownload);

module.exports = router;
