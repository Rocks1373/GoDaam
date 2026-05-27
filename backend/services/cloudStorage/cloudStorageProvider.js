const { GoogleDriveStorage } = require('./googleDriveStorage');
const { OneDriveStorage } = require('./oneDriveStorage');
const { getEnvRootFolderId, getEffectiveRootFolderId } = require('../googleDriveRootFolderStore');

const SUBFOLDERS = {
  CUSTOMER_PO: 'Customer_PO',
  INVOICES: 'Invoices',
  DELIVERY_NOTES: 'Delivery_Notes',
  POD: 'POD',
  ORDER_IMAGES: 'Order_Images',
  ACCOUNTING_DOCUMENTS: 'Accounting_Documents',
  OTHER: 'Other',
};

function getActiveStorageProviderName() {
  return String(process.env.STORAGE_PROVIDER || 'GOOGLE_DRIVE').trim().toUpperCase() || 'GOOGLE_DRIVE';
}

function getDriver() {
  const p = getActiveStorageProviderName();
  if (p === 'ONEDRIVE') {
    return new OneDriveStorage();
  }
  return new GoogleDriveStorage();
}

/**
 * @returns {import('./cloudStorageTypes').CloudStorageDriver}
 */
function getCloudDriver() {
  return getDriver();
}

function getConfiguredRootFolderId() {
  return getEnvRootFolderId();
}

async function getConfiguredRootFolderIdAsync() {
  return getEffectiveRootFolderId();
}

/**
 * Ensure the warehouse folder exists directly under the configured root folder.
 * @param {{ warehouse_code: string }} ctx
 * @returns {Promise<{ id: string, name: string, webViewLink?: string|null }>}
 */
async function ensureWarehouseFolder(ctx) {
  await assertDriveUploadReady();
  const driver = getCloudDriver();
  const rootId = await getConfiguredRootFolderIdAsync();
  if (!rootId) {
    throw new Error('Google Drive root folder is not configured. Open Settings → Google Drive and repair the root folder.');
  }
  if (typeof driver.assertFolderAccessible === 'function') {
    await driver.assertFolderAccessible(rootId, 'root folder (GOOGLE_DRIVE_ROOT_FOLDER_ID)');
  }
  const whCode = String(ctx.warehouse_code || '').trim() || 'WH';
  return driver.createFolderIfNotExists(rootId, whCode);
}

/**
 * Ensure sales order folder only (no document subfolders at SO root).
 * Document subfolders are created per outbound under ensureOutboundBranchFolders.
 */
async function ensureSalesOrderFolder(ctx) {
  const driver = getCloudDriver();
  const whFolderId = String(ctx.warehouseFolderId || '').trim();
  if (!whFolderId) throw new Error('warehouseFolderId required');
  const whCode = String(ctx.warehouse_code || '').trim() || 'WH';
  const so = String(ctx.sales_order_number || '').trim();
  if (!so) throw new Error('sales_order_number required');

  const soFolderName = `SO_${so}`;
  const soFolder = await driver.createFolderIfNotExists(whFolderId, soFolderName);

  const relPath = `${whCode}/${soFolderName}`;
  return {
    storage_provider: getActiveStorageProviderName(),
    root_folder_id: whFolderId,
    sales_order_folder_id: soFolder.id,
    sales_order_folder_name: soFolderName,
    sales_order_folder_path: relPath,
    customer_po_folder_id: null,
    invoices_folder_id: null,
    delivery_notes_folder_id: null,
    pod_folder_id: null,
    order_images_folder_id: null,
    accounting_documents_folder_id: null,
    other_folder_id: null,
    cloud_web_url: soFolder.webViewLink || null,
  };
}

/**
 * Per-outbound folders under SO: Outbound_{outbound}/Customer_PO|Invoices|…|POD
 */
async function ensureOutboundBranchFolders(ctx) {
  const driver = getCloudDriver();
  const soFolderId = String(ctx.sales_order_folder_id || '').trim();
  const outbound = String(ctx.outbound_number || '').trim();
  if (!soFolderId) throw new Error('sales_order_folder_id required');
  if (!outbound) throw new Error('outbound_number required');

  const obFolderName = `Outbound_${outbound}`;
  const obRoot = await driver.createFolderIfNotExists(soFolderId, obFolderName);

  const customer_po_folder_id = (await driver.createFolderIfNotExists(obRoot.id, SUBFOLDERS.CUSTOMER_PO)).id;
  const invoices_folder_id = (await driver.createFolderIfNotExists(obRoot.id, SUBFOLDERS.INVOICES)).id;
  const delivery_notes_folder_id = (await driver.createFolderIfNotExists(obRoot.id, SUBFOLDERS.DELIVERY_NOTES)).id;
  const pod_folder_id = (await driver.createFolderIfNotExists(obRoot.id, SUBFOLDERS.POD)).id;
  const order_images_folder_id = (await driver.createFolderIfNotExists(obRoot.id, SUBFOLDERS.ORDER_IMAGES)).id;
  const accounting_folder_id = (await driver.createFolderIfNotExists(obRoot.id, SUBFOLDERS.ACCOUNTING_DOCUMENTS)).id;
  const other_folder_id = (await driver.createFolderIfNotExists(obRoot.id, SUBFOLDERS.OTHER)).id;

  return {
    outbound_folder_drive_id: obRoot.id,
    outbound_folder_name: obFolderName,
    customer_po_folder_id,
    invoice_folder_id: invoices_folder_id,
    invoices_folder_id,
    accounting_folder_id,
    raw_delivery_note_folder_id: delivery_notes_folder_id,
    delivery_notes_folder_id,
    pod_folder_id,
    order_images_folder_id,
    other_folder_id,
  };
}

function folderIdForOutboundBranchDocType(branchFolders, documentType) {
  if (!branchFolders) return null;
  const t = String(documentType || '').toUpperCase();
  if (t === 'CUSTOMER_PO') return branchFolders.customer_po_folder_id;
  if (t === 'INVOICE') return branchFolders.invoice_folder_id || branchFolders.invoices_folder_id;
  if (t === 'ACCOUNTING_DOCUMENT') return branchFolders.accounting_folder_id;
  if (t === 'DELIVERY_NOTE') return branchFolders.raw_delivery_note_folder_id || branchFolders.delivery_notes_folder_id;
  if (t === 'POD' || t === 'SIGNED_POD') return branchFolders.pod_folder_id;
  if (t === 'ORDER_IMAGE') return branchFolders.order_images_folder_id;
  if (t === 'OTHER') return branchFolders.other_folder_id;
  return branchFolders.other_folder_id;
}

async function assertDriveUploadReady() {
  if (getActiveStorageProviderName() !== 'GOOGLE_DRIVE') return;
  const { validateGoogleDriveUploadPermissions } = require('../googleDriveOAuthClient');
  const { getGoogleDriveAuthMode } = require('../googleDriveOAuthConfig');
  if (getGoogleDriveAuthMode() === 'oauth') {
    await validateGoogleDriveUploadPermissions();
  }
}

async function uploadDocument({ folderId, filePath, fileName, mimeType }) {
  await assertDriveUploadReady();
  const driver = getCloudDriver();
  return driver.uploadDocument({ folderId, filePath, fileName, mimeType });
}

async function replaceDocument({ fileId, filePath, mimeType }) {
  await assertDriveUploadReady();
  const driver = getCloudDriver();
  return driver.replaceDocument({ fileId, filePath, mimeType });
}

async function getWebLink(fileId) {
  const driver = getCloudDriver();
  return driver.getWebLink(fileId);
}

/** @returns {Promise<Buffer>} */
async function downloadDocument(fileId) {
  const p = getActiveStorageProviderName();
  if (p === 'ONEDRIVE') {
    const err = new Error('Document export download is not implemented for OneDrive (STORAGE_PROVIDER=ONEDRIVE).');
    err.code = 'EXPORT_NOT_IMPLEMENTED';
    throw err;
  }
  const driver = getCloudDriver();
  if (typeof driver.downloadFileMedia !== 'function') {
    throw new Error('Cloud driver does not support downloadFileMedia');
  }
  return driver.downloadFileMedia(fileId);
}

async function createFolderIfNotExists(parentFolderId, folderName) {
  const driver = getCloudDriver();
  return driver.createFolderIfNotExists(parentFolderId, folderName);
}

async function deleteTempFile(filePath) {
  const driver = getCloudDriver();
  return driver.deleteFile(filePath);
}

module.exports = {
  getActiveStorageProviderName,
  getCloudDriver,
  getConfiguredRootFolderId,
  getConfiguredRootFolderIdAsync,
  ensureWarehouseFolder,
  ensureSalesOrderFolder,
  ensureOutboundBranchFolders,
  folderIdForOutboundBranchDocType,
  assertDriveUploadReady,
  uploadDocument,
  replaceDocument,
  getWebLink,
  downloadDocument,
  createFolderIfNotExists,
  deleteTempFile,
  SUBFOLDERS,
};
