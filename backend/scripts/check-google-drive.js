#!/usr/bin/env node
/**
 * Quick Google Drive setup check (local or VPS).
 *   cd backend && node scripts/check-google-drive.js
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { getGoogleDriveSetupStatus } = require('../services/googleDriveSetupStatus');

(async () => {
  const wid = Number(process.argv[2]) || 1;
  const s = await getGoogleDriveSetupStatus(wid);
  console.log(JSON.stringify(s, null, 2));
  if (s.auth_mode === 'oauth' && !s.oauth_connected) {
    console.error('\nFAIL: Google Drive OAuth not connected. Admin → Settings → Google Drive → Connect.');
    process.exit(1);
  }
  if (!s.root_accessible) {
    console.error('\nFAIL: Root folder not accessible to the connected Google account.');
    process.exit(1);
  }
  console.log('\nOK: Root folder is accessible.');
  if (s.warehouse_drive_folder_id && !s.warehouse_drive_accessible) {
    console.error(
      '\nFAIL: Warehouse Drive folder in DB is stale or not visible to the connected account.'
    );
    console.error(`  Stale id: ${s.warehouse_drive_folder_id}`);
    console.error(
      `  Fix: UPDATE warehouses SET google_drive_folder_id = NULL WHERE id = ${wid}; then restart backend and Load/upload again.`
    );
    console.error('  (Or just Load/upload — the app will recreate WH under the shared root automatically.)');
    process.exit(1);
  }
  if (s.warehouse_drive_url) console.log('WH folder:', s.warehouse_drive_url);
  process.exit(0);
})().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
