const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getGoogleDriveAuthMode, getDriveScope } = require('../googleDriveOAuthConfig');
const { getAuthorizedOAuth2Client } = require('../googleDriveOAuthClient');

/**
 * Google Drive storage — OAuth user My Drive (default) or legacy service account.
 * Root folder (GOOGLE_DRIVE_ROOT_FOLDER_ID) must live in the connected user's Drive.
 */
class GoogleDriveStorage {
  constructor() {
    this.name = 'GOOGLE_DRIVE';
    this._jsonPath = String(process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_PATH || '').trim();
  }

  _resolveJsonPath() {
    const raw = this._jsonPath.replace(/^["']|["']$/g, '');
    if (!raw) {
      throw new Error('GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON_PATH is not set');
    }
    const repoRoot = path.join(__dirname, '..', '..', '..');
    const baseName = path.basename(raw);
    const candidates = [
      raw,
      path.join(process.cwd(), raw),
      path.join(__dirname, '..', '..', raw),
      path.join(repoRoot, raw),
      path.join(repoRoot, baseName),
      path.join(repoRoot, 'delete', 'credentials-local', baseName),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return path.resolve(p);
    }
    throw new Error(`Google service account JSON not found at ${raw}`);
  }

  _serviceAccountAuth() {
    const abs = this._resolveJsonPath();
    const raw = fs.readFileSync(abs, 'utf8');
    const creds = JSON.parse(raw);
    return new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  }

  async _getAuth() {
    if (getGoogleDriveAuthMode() === 'service_account') {
      return this._serviceAccountAuth();
    }
    return getAuthorizedOAuth2Client();
  }

  async getDrive() {
    const auth = await this._getAuth();
    if (getGoogleDriveAuthMode() === 'oauth') {
      const creds = auth.credentials || {};
      if (!creds.access_token) {
        throw new Error(
          'Google Drive is not connected. Open Settings → Google Drive → Reconnect.'
        );
      }
    }
    return google.drive({ version: 'v3', auth });
  }

  /** @returns {string|null} service account email (legacy mode only) */
  getServiceAccountEmail() {
    if (getGoogleDriveAuthMode() !== 'service_account') return null;
    const abs = this._resolveJsonPath();
    const creds = JSON.parse(fs.readFileSync(abs, 'utf8'));
    return String(creds.client_email || '').trim() || null;
  }

  async assertFolderAccessible(folderId, label = 'folder') {
    const drive = await this.getDrive();
    const id = String(folderId || '').trim();
    if (!id) throw new Error(`Google Drive ${label} id is empty`);
    try {
      await drive.files.get({
        fileId: id,
        fields: 'id, name, driveId',
        supportsAllDrives: true,
      });
    } catch (e) {
      const status = e?.code || e?.response?.status;
      if (status === 404 || status === 403) {
        if (getGoogleDriveAuthMode() === 'oauth') {
          const scope = getDriveScope();
          const driveFileOnly = scope.includes('drive.file') && !scope.includes('/auth/drive');
          const scopeHint = driveFileOnly
            ? ' OAuth scope is drive.file — it cannot open folders you created manually. Set GOOGLE_DRIVE_OAUTH_SCOPE=https://www.googleapis.com/auth/drive in backend/.env, restart backend, then Settings → Google Drive → Reconnect.'
            : ' Ensure GOOGLE_DRIVE_ROOT_FOLDER_ID is a folder in the connected Google account’s My Drive, then Reconnect in Settings → Google Drive if you changed accounts.';
          throw new Error(
            `Google Drive ${label} not accessible (id ${id}).${scopeHint}`
          );
        }
        const email = this.getServiceAccountEmail();
        throw new Error(
          `Google Drive ${label} not accessible (id ${id}). Share that folder with the service account as Editor: ${email || '(see JSON client_email)'}`
        );
      }
      throw e;
    }
  }

  async createFolderIfNotExists(parentFolderId, folderName) {
    const drive = await this.getDrive();
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
    const drive = await this.getDrive();
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
    const drive = await this.getDrive();
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
    const drive = await this.getDrive();
    const res = await drive.files.get({
      fileId: String(fileId),
      fields: 'id, webViewLink, webContentLink',
      supportsAllDrives: true,
    });
    return { webViewLink: res.data.webViewLink || null, webContentLink: res.data.webContentLink || null };
  }

  async downloadFileMedia(fileId) {
    const drive = await this.getDrive();
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
