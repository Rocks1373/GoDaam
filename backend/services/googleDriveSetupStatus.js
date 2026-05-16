const { promisify } = require('util');
const db = require('../db');
const { getConfiguredRootFolderId, getActiveStorageProviderName } = require('./cloudStorage/cloudStorageProvider');
const { GoogleDriveStorage } = require('./cloudStorage/googleDriveStorage');

const dbGet = promisify(db.get.bind(db));

function driveFolderUrl(folderId) {
  const id = String(folderId || '').trim();
  return id ? `https://drive.google.com/drive/folders/${id}` : null;
}

/**
 * Live check: env, service account, root share, warehouse folder on Drive.
 */
async function getGoogleDriveSetupStatus(warehouseId) {
  const provider = getActiveStorageProviderName();
  const rootFolderId = getConfiguredRootFolderId();
  const out = {
    provider,
    configured: provider === 'GOOGLE_DRIVE' && !!rootFolderId,
    root_folder_id: rootFolderId || null,
    root_accessible: false,
    root_error: null,
    service_account_email: null,
    warehouse_id: Number(warehouseId) || null,
    warehouse_code: null,
    warehouse_drive_folder_id: null,
    warehouse_drive_url: null,
    warehouse_drive_accessible: false,
    where_folders_go: null,
    share_instructions: null,
  };

  if (provider !== 'GOOGLE_DRIVE') {
    out.root_error = `STORAGE_PROVIDER is ${provider}, not GOOGLE_DRIVE`;
    return out;
  }
  if (!rootFolderId) {
    out.root_error = 'GOOGLE_DRIVE_ROOT_FOLDER_ID is not set in backend/.env';
    return out;
  }

  let drive;
  try {
    drive = new GoogleDriveStorage();
    out.service_account_email = drive.getServiceAccountEmail();
  } catch (e) {
    out.root_error = e.message;
    return out;
  }

  try {
    await drive.assertFolderAccessible(rootFolderId, 'root folder (GOOGLE_DRIVE_ROOT_FOLDER_ID)');
    out.root_accessible = true;
  } catch (e) {
    out.root_error = e.message;
    out.share_instructions = `In Google Drive, open your root folder → Share → add ${out.service_account_email} as Editor. Then restart the backend.`;
  }

  const wid = Number(warehouseId);
  if (!wid) {
    out.where_folders_go = out.root_accessible
      ? 'Select a warehouse, then Load a sales order — folders appear under WHx/SO_… inside the shared root.'
      : 'Fix root folder sharing first (see share_instructions).';
    return out;
  }

  const wh = await dbGet(
    `SELECT id, warehouse_code, google_drive_folder_id FROM warehouses WHERE id = ?`,
    [wid]
  );
  if (!wh) {
    out.root_error = out.root_error || 'Warehouse not found';
    return out;
  }
  out.warehouse_code = wh.warehouse_code;
  out.warehouse_drive_folder_id = String(wh.google_drive_folder_id || '').trim() || null;
  out.warehouse_drive_url = driveFolderUrl(out.warehouse_drive_folder_id);

  if (out.warehouse_drive_folder_id) {
    try {
      await drive.assertFolderAccessible(out.warehouse_drive_folder_id, 'warehouse folder');
      out.warehouse_drive_accessible = true;
    } catch (e) {
      out.root_error = out.root_error || e.message;
    }
  }

  if (out.root_accessible && out.warehouse_drive_folder_id && !out.warehouse_drive_accessible) {
    out.where_folders_go =
      `Root is OK, but warehouse folder in the database is from an OLD service account and is not visible anymore. The app will recreate ${out.warehouse_code || 'WHx'} under the shared root on the next Load/upload (or run: UPDATE warehouses SET google_drive_folder_id = NULL WHERE id = ${wid};).`;
  } else if (out.root_accessible) {
    out.where_folders_go = `New warehouse folders are created under your shared root → ${out.warehouse_code || 'WHx'}/SO_<number>/`;
  } else if (out.warehouse_drive_accessible) {
    out.where_folders_go =
      `Your new root folder is NOT shared with the service account yet, but this warehouse already has a Drive folder from an earlier setup. Open the WH folder link below — SO folders (SO_123456, etc.) are inside it, NOT inside the new root you configured in .env.`;
  } else {
    out.where_folders_go =
      'Neither the configured root nor the warehouse Drive folder is accessible. Share the root folder with the service account (see share_instructions) and restart the backend.';
  }

  return out;
}

async function isGoogleDriveFolderAccessible(folderId) {
  const id = String(folderId || '').trim();
  if (!id) return false;
  if (getActiveStorageProviderName() !== 'GOOGLE_DRIVE') return true;
  try {
    const drive = new GoogleDriveStorage();
    await drive.assertFolderAccessible(id, 'folder');
    return true;
  } catch {
    return false;
  }
}

module.exports = { getGoogleDriveSetupStatus, driveFolderUrl, isGoogleDriveFolderAccessible };
