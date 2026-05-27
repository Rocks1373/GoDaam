const { promisify } = require('util');
const db = require('../db');
const { getConfiguredRootFolderIdAsync, getActiveStorageProviderName } = require('./cloudStorage/cloudStorageProvider');
const { GoogleDriveStorage } = require('./cloudStorage/googleDriveStorage');
const { getGoogleDriveAuthMode } = require('./googleDriveOAuthConfig');
const { getGoogleDriveOAuthStatus } = require('./googleDriveConnectionStore');

const dbGet = promisify(db.get.bind(db));

function driveFolderUrl(folderId) {
  const id = String(folderId || '').trim();
  return id ? `https://drive.google.com/drive/folders/${id}` : null;
}

/**
 * Live check: OAuth connection, root folder access, warehouse folder on Drive.
 */
async function getGoogleDriveSetupStatus(warehouseId) {
  const provider = getActiveStorageProviderName();
  const authMode = getGoogleDriveAuthMode();
  const rootFolderId = await getConfiguredRootFolderIdAsync();
  const connection = await getGoogleDriveOAuthStatus();
  const out = {
    provider,
    auth_mode: authMode,
    configured: provider === 'GOOGLE_DRIVE' && !!rootFolderId,
    root_folder_id: rootFolderId || null,
    root_accessible: false,
    root_error: null,
    oauth_connected: connection.connected,
    google_user_email: connection.google_email || connection.google_user_email,
    token_expiry: connection.token_expiry,
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
    out.root_error = 'Google Drive root folder is not configured.';
    out.share_instructions = 'Click Repair root folder to create/use a GoDaam folder in the connected Google Drive account.';
    return out;
  }

  if (authMode === 'oauth' && !connection.connected) {
    out.root_error =
      'Google Drive is not connected. Admin: open Settings → Google Drive → Connect Google Drive.';
    out.share_instructions =
      'Create an OAuth Web client in Google Cloud, add the redirect URI from this page, set client id/secret in .env, then Connect.';
    return out;
  }

  if (authMode === 'oauth' && connection.connected) {
    try {
      const { getDriveTokenScopeInfo } = require('./googleDriveOAuthClient');
      const scopeInfo = await getDriveTokenScopeInfo();
      if (scopeInfo.scope_stale) {
        out.root_error =
          'Google Drive permission is outdated (token still has drive.file only). Click Reconnect on Settings → Google Drive so Google can grant full Drive access to your GAPP folder.';
        out.share_instructions = `Granted: ${scopeInfo.granted_scope || '—'} → Required: ${scopeInfo.required_scope}`;
        return out;
      }
    } catch {
      /* continue to folder check */
    }
  }

  let drive;
  try {
    drive = new GoogleDriveStorage();
    if (authMode === 'service_account') {
      out.service_account_email = drive.getServiceAccountEmail();
    }
  } catch (e) {
    out.root_error = e.message;
    return out;
  }

  try {
    await drive.assertFolderAccessible(rootFolderId, 'root folder (GOOGLE_DRIVE_ROOT_FOLDER_ID)');
    out.root_accessible = true;
  } catch (e) {
    out.root_error = e.message;
    if (authMode === 'oauth') {
      out.share_instructions =
        'Click Repair root folder to create/use a GoDaam folder in the connected Google Drive account, then Test upload.';
    } else {
      out.share_instructions = `Share the root folder with ${out.service_account_email} as Editor.`;
    }
  }

  const wid = Number(warehouseId);
  if (!wid) {
    out.where_folders_go = out.root_accessible
      ? 'Select a warehouse, then Load a sales order — folders appear under WHx/SO_… inside the root folder.'
      : 'Connect Google Drive and fix root folder access first.';
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

  if (out.warehouse_drive_folder_id && out.root_accessible) {
    try {
      await drive.assertFolderAccessible(out.warehouse_drive_folder_id, 'warehouse folder');
      out.warehouse_drive_accessible = true;
    } catch (e) {
      out.root_error = out.root_error || e.message;
    }
  }

  if (out.root_accessible && out.warehouse_drive_folder_id && !out.warehouse_drive_accessible) {
    out.where_folders_go =
      `Warehouse folder in DB is not visible to the connected account. Clear google_drive_folder_id for warehouse ${wid} or upload again — WH folder will be recreated under root.`;
  } else if (out.root_accessible) {
    out.where_folders_go = `Folders: root → ${out.warehouse_code || 'WHx'}/SO_<number>/ (same structure as before)`;
  } else {
    out.where_folders_go = 'Fix Google Drive connection and root folder first.';
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
