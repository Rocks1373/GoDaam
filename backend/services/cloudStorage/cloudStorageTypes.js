/**
 * @typedef {object} CloudStorageDriver
 * @property {string} name
 * @property {(parentFolderId: string, folderName: string) => Promise<{ id: string, name: string, webViewLink?: string|null }>} createFolderIfNotExists
 * @property {(opts: { folderId: string, filePath: string, fileName: string, mimeType: string }) => Promise<{ id: string, webViewLink?: string|null, webContentLink?: string|null }>} uploadDocument
 * @property {(opts: { fileId: string, filePath: string, mimeType: string }) => Promise<{ id: string, webViewLink?: string|null }>} replaceDocument
 * @property {(fileId: string) => Promise<{ webViewLink?: string|null, webContentLink?: string|null }>} getWebLink
 * @property {(filePath: string) => Promise<void>} deleteFile
 */

module.exports = {};
