import { createReadStream } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import { fileHash } from './backups.js';
import { createHash } from 'node:crypto';

const failure = (code, message) => Object.assign(new Error(message), { code });
async function responseJson(response, code) {
  try { return await response.json(); } catch { throw failure(code, 'Google backup returned an unreadable response. Check connectivity and try again.'); }
}
const archiveName = /^timekeeper-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.tkbackup$/;
export async function googleBackupOptions(env = process.env) {
  const fields = ['clientId', 'clientSecret', 'refreshToken', 'folderId'];
  const names = ['GOOGLE_BACKUP_CLIENT_ID', 'GOOGLE_BACKUP_CLIENT_SECRET', 'GOOGLE_BACKUP_REFRESH_TOKEN', 'GOOGLE_BACKUP_FOLDER_ID'];
  let config;
  if (env.GOOGLE_BACKUP_CREDENTIALS_FILE) {
    const contents = await readFile(env.GOOGLE_BACKUP_CREDENTIALS_FILE, 'utf8');
    try { config = JSON.parse(contents); } catch { throw Error('Google backup credentials file is not valid JSON.'); }
  } else config = Object.fromEntries(fields.map((field, i) => [field, env[names[i]]]));
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Google backup credentials must be a JSON object.');
  if (!env.GOOGLE_BACKUP_CREDENTIALS_FILE && !fields.some(field => config[field])) return null;
  if (!fields.every(field => typeof config[field] === 'string' && config[field].length) || !/^[a-zA-Z0-9_-]+$/.test(config.folderId)) throw Error('Google backups need a client ID, client secret, refresh token, and folder ID.');
  return config;
}

export function googleDriveDestination(config, { fetchImpl = fetch } = {}) {
  return {
    identity: createHash('sha256').update(config.clientId + '|' + config.folderId).digest('hex'),
    async upload(archive, retain) {
      const tokenResponse = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, refresh_token: config.refreshToken, grant_type: 'refresh_token' })
      });
      if (!tokenResponse.ok) throw failure('GOOGLE_AUTH_FAILED', `Google backup authentication failed (HTTP ${tokenResponse.status}). Reconnect the Google account.`);
      const tokens = await responseJson(tokenResponse, 'GOOGLE_AUTH_FAILED');
      if (typeof tokens.access_token !== 'string' || !tokens.access_token) throw failure('GOOGLE_AUTH_FAILED', 'Google did not issue an access token.');
      const headers = { Authorization: `Bearer ${tokens.access_token}` };
      const bytes = (await stat(archive.path)).size;
      const expectedMd5 = await fileHash(archive.path, 'md5');
      const initial = await fetchImpl('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size,md5Checksum', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-Upload-Content-Type': 'application/octet-stream', 'X-Upload-Content-Length': String(bytes) },
        body: JSON.stringify({ name: archive.name, parents: [config.folderId], appProperties: { application: 'timekeeper', backupFormat: '1' } }),
        redirect: 'error', signal: AbortSignal.timeout(30_000)
      });
      if (!initial.ok) throw failure('GOOGLE_UPLOAD_FAILED', `Google backup upload could not start (HTTP ${initial.status}). Check folder access and storage quota.`);
      const location = new URL(initial.headers.get('location'));
      if (location.protocol !== 'https:' || location.hostname !== 'www.googleapis.com' || location.username || location.password || !location.pathname.startsWith('/upload/drive/')) throw failure('GOOGLE_UPLOAD_DESTINATION', 'Google returned an unexpected upload destination.');
      const uploaded = await fetchImpl(location.toString(), {
        method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes) },
        body: createReadStream(archive.path), duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(120_000)
      });
      if (!uploaded.ok) throw failure('GOOGLE_UPLOAD_FAILED', `Google backup upload failed (HTTP ${uploaded.status}).`);
      const receipt = await responseJson(uploaded, 'GOOGLE_UPLOAD_FAILED');
      if (typeof receipt.id !== 'string' || !receipt.id || Number(receipt.size) !== bytes || receipt.md5Checksum !== expectedMd5) throw failure('GOOGLE_CHECKSUM_FAILED', 'Google backup upload checksum verification failed. Older backups were kept.');

      // Only prune this app's archive files, and only after the new upload is verified.
      const files = [], seen = new Set(); let pageToken = '';
      do {
        if (seen.has(pageToken)) throw failure('GOOGLE_RETENTION_FAILED', 'Google backup listing did not complete. Older backups were kept.');
        seen.add(pageToken);
        const query = new URLSearchParams({
          q: `'${config.folderId}' in parents and trashed = false and appProperties has { key='application' and value='timekeeper' } and appProperties has { key='backupFormat' and value='1' }`,
          fields: 'nextPageToken,files(id,name,createdTime)', pageSize: '100', ...(pageToken ? { pageToken } : {})
        });
        const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files?${query}`, { headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw failure('GOOGLE_RETENTION_FAILED', `Google backup retention listing failed (HTTP ${response.status}). Older backups were kept.`);
        const listing = await responseJson(response, 'GOOGLE_RETENTION_FAILED');
        if (!Array.isArray(listing.files)) throw failure('GOOGLE_RETENTION_FAILED', 'Google backup listing was incomplete. Older backups were kept.');
        files.push(...listing.files.filter(file => typeof file.id === 'string' && archiveName.test(file.name)));
        pageToken = listing.nextPageToken || '';
      } while (pageToken);
      files.sort((a, b) => b.name.localeCompare(a.name));
      const keep = new Set([receipt.id, ...files.filter(f => f.id !== receipt.id).slice(0, retain - 1).map(f => f.id)]);
      for (const file of files) if (!keep.has(file.id)) {
        const response = await fetchImpl(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(file.id)}`, { method: 'DELETE', headers, redirect: 'error', signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw failure('GOOGLE_RETENTION_FAILED', `Google backup retention cleanup failed (HTTP ${response.status}).`);
      }
      return { id: receipt.id };
    }
  };
}
