const express = require('express');
const { sendApkMetadata, sendApkDownload } = require('../lib/mobileApk');

const router = express.Router();
router.get('/', sendApkMetadata);
router.get('/apk', sendApkDownload);

module.exports = router;
