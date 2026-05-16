const { GoogleDriveStorage } = require('./googleDriveStorage');
const { OneDriveStorage } = require('./oneDriveStorage');

const SUBFOLDERS = {
  CUSTOMER_PO: 'Customer_PO',
  INVOICES: 'Invoices',
  DELIVERY_NOTES: 'Delivery_Notes',
  POD: 'POD',
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
  return String(process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID || '').trim();
}

/**
 * Ensure the warehouse folder exists directly under the configured root folder.
 * @param {{ warehouse_code: string }} ctx
 * @returns {Promise<{ id: string, name: string, webViewLink?: string|null }>}
 */
async function ensureWarehouseFolder(ctx) {
  const driver = getCloudDriver();
  const rootId = getConfiguredRootFolderId();
  if (!rootId) {
    throw new Error('GOOGLE_DRIVE_ROOT_FOLDER_ID is not configured');
  }
  if (typeof driver.assertFolderAccessible === 'function') {
    await driver.assertFolderAccessible(rootId, 'root folder (GOOGLE_DRIVE_ROOT_FOLDER_ID)');
  }
  const whCode = String(ctx.warehouse_code || '').trim() || 'WH';
  return driver.createFolderIfNotExists(rootId, whCode);
}

/**
 * Ensure sales order + standard subfolders under the warehouse Drive folder.
 * @param {{ warehouseFolderId: string, warehouse_code: string, sales_order_number: string }} ctx
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

  const customer_po_folder_id = (await driver.createFolderIfNotExists(soFolder.id, SUBFOLDERS.CUSTOMER_PO)).id;
  const invoices_folder_id = (await driver.createFolderIfNotExists(soFolder.id, SUBFOLDERS.INVOICES)).id;
  const delivery_notes_folder_id = (await driver.createFolderIfNotExists(soFolder.id, SUBFOLDERS.DELIVERY_NOTES)).id;
  const pod_folder_id = (await driver.createFolderIfNotExists(soFolder.id, SUBFOLDERS.POD)).id;
  const accounting_documents_folder_id = (await driver.createFolderIfNotExists(soFolder.id, SUBFOLDERS.ACCOUNTING_DOCUMENTS)).id;
  const other_folder_id = (await driver.createFolderIfNotExists(soFolder.id, SUBFOLDERS.OTHER)).id;

  const relPath = `${whCode}/${soFolderName}`;
  return {
    storage_provider: getActiveStorageProviderName(),
    root_folder_id: whFolderId,
    sales_order_folder_id: soFolder.id,
    sales_order_folder_name: soFolderName,
    sales_order_folder_path: relPath,
    customer_po_folder_id,
    invoices_folder_id,
    delivery_notes_folder_id,
    pod_folder_id,
    accounting_documents_folder_id,
    other_folder_id,
    cloud_web_url: soFolder.webViewLink || null,
  };
}

async function uploadDocument({ folderId, filePath, fileName, mimeType }) {
  const driver = getCloudDriver();
  return driver.uploadDocument({ folderId, filePath, fileName, mimeType });
}

async function replaceDocument({ fileId, filePath, mimeType }) {
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
  ensureWarehouseFolder,
  ensureSalesOrderFolder,
  uploadDocument,
  replaceDocument,
  getWebLink,
  downloadDocument,
  createFolderIfNotExists,
  deleteTempFile,
  SUBFOLDERS,
};
