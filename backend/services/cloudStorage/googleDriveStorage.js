const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

/**
 * Google Drive implementation (service account).
 * Root folder must be shared with the service account email.
 */
class GoogleDriveStorage {
  constructor() {
    this.name = 'GOOGLE_DRIVE';
    this._drive = null;
    this._jsonPath = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_PATH || '').trim();
  }

  _auth() {
    if (!this._jsonPath) {
      throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_PATH is not set');
    }
    const abs = path.isAbsolute(this._jsonPath) ? this._jsonPath : path.join(process.cwd(), this._jsonPath);
    if (!fs.existsSync(abs)) {
      throw new Error(`Google service account JSON not found at ${abs}`);
    }
    const raw = fs.readFileSync(abs, 'utf8');
    const creds = JSON.parse(raw);
    const auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    return auth;
  }

  getDrive() {
    if (!this._drive) {
      const auth = this._auth();
      this._drive = google.drive({ version: 'v3', auth });
    }
    return this._drive;
  }

  async createFolderIfNotExists(parentFolderId, folderName) {
    const drive = this.getDrive();
    const name = String(folderName || '').trim();
    if (!name) throw new Error('folderName required');
    const parent = String(parentFolderId || '').trim();
    if (!parent) throw new Error('parentFolderId required');

    const existing = await drive.files.list({
      q: `'${parent.replace(/'/g, "\\'")}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name, webViewLink)',
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    const files = existing.data.files || [];
    const hit = files.find((f) => String(f.name || '').trim() === name);
    if (hit?.id) {
      return { id: hit.id, name: hit.name || name, webViewLink: hit.webViewLink || null };
    }

    const created = await drive.files.create({
      requestBody: {
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
      },
      fields: 'id, name, webViewLink',
      supportsAllDrives: true,
    });
    const f = created.data;
    return { id: f.id, name: f.name || name, webViewLink: f.webViewLink || null };
  }

  async uploadDocument({ folderId, filePath, fileName, mimeType }) {
    const drive = this.getDrive();
    const media = {
      mimeType: mimeType || 'application/octet-stream',
      body: fs.createReadStream(filePath),
    };
    const res = await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [String(folderId)],
      },
      media,
      fields: 'id, name, webViewLink, webContentLink',
      supportsAllDrives: true,
    });
    const f = res.data;
    let webViewLink = f.webViewLink || null;
    let webContentLink = f.webContentLink || null;
    if (!webViewLink && f.id) {
      const meta = await drive.files.get({
        fileId: f.id,
        fields: 'id, webViewLink, webContentLink',
        supportsAllDrives: true,
      });
      webViewLink = meta.data.webViewLink || null;
      webContentLink = meta.data.webContentLink || null;
    }
    return { id: f.id, webViewLink, webContentLink };
  }

  async replaceDocument({ fileId, filePath, mimeType }) {
    const drive = this.getDrive();
    const media = {
      mimeType: mimeType || 'application/octet-stream',
      body: fs.createReadStream(filePath),
    };
    const res = await drive.files.update({
      fileId: String(fileId),
      media,
      fields: 'id, webViewLink, webContentLink',
      supportsAllDrives: true,
    });
    const f = res.data;
    return { id: f.id, webViewLink: f.webViewLink || null, webContentLink: f.webContentLink || null };
  }

  async getWebLink(fileId) {
    const drive = this.getDrive();
    const res = await drive.files.get({
      fileId: String(fileId),
      fields: 'id, webViewLink, webContentLink',
      supportsAllDrives: true,
    });
    return { webViewLink: res.data.webViewLink || null, webContentLink: res.data.webContentLink || null };
  }

  /** Download file bytes (binary Google Drive file, e.g. PDF). */
  async downloadFileMedia(fileId) {
    const drive = this.getDrive();
    const res = await drive.files.get(
      { fileId: String(fileId), alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    return Buffer.from(res.data);
  }

  async deleteFile(filePath) {
    try {
      await fs.promises.unlink(filePath);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { GoogleDriveStorage };
