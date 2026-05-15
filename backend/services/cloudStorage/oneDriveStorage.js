/**
 * OneDrive storage provider — placeholder for future STORAGE_PROVIDER=ONEDRIVE.
 * @implements {import('./cloudStorageTypes').CloudStorageDriver}
 */
class OneDriveStorage {
  constructor() {
    this.name = 'ONEDRIVE';
  }

  ensureClient() {
    throw new Error('OneDrive provider not configured yet.');
  }

  async createFolderIfNotExists() {
    this.ensureClient();
  }

  async uploadDocument() {
    this.ensureClient();
  }

  async replaceDocument() {
    this.ensureClient();
  }

  async getWebLink() {
    this.ensureClient();
  }

  async deleteFile() {
    this.ensureClient();
  }

  async downloadFileMedia() {
    this.ensureClient();
  }
}

module.exports = { OneDriveStorage };
