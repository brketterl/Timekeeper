import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import { readFile, open, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const [clientPath, outputPath] = process.argv.slice(2);
let server, output, completed = false, cancelSetup;
const interrupt = () => cancelSetup?.(Error('Google backup setup cancelled.'));
async function responseJson(response) {
  try { return await response.json(); } catch { throw Error('Google returned an unreadable response. Retry setup.'); }
}
try {
  if (!clientPath || !outputPath) throw Error('Usage: npm run backup:google-setup -- /private/client.json /private/google-backup.json');
  let client;
  try { client = JSON.parse(await readFile(clientPath, 'utf8')).installed; }
  catch { throw Error('Could not read the Google OAuth client JSON. Keep credentials private and download a fresh Desktop client file.'); }
  if (!client?.client_id || !client.client_secret) throw Error('Use a Google OAuth Desktop app client JSON file.');
  output = await open(resolve(outputPath), 'wx', 0o600);
  const state = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url');
  let complete, reject;
  const finished = new Promise((res, rej) => { complete = res; reject = rej; });
  cancelSetup = reject; process.once('SIGINT', interrupt);
  let accepting = true, redirectUri;
  server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const receivedState = Buffer.from(url.searchParams.get('state') || '');
    if (url.pathname !== '/oauth2/callback' || !accepting || receivedState.length !== state.length || !timingSafeEqual(receivedState, Buffer.from(state))) {
      res.writeHead(400); return res.end('Invalid OAuth callback.');
    }
    accepting = false;
    try {
      const code = url.searchParams.get('code');
      if (!code || url.searchParams.has('error')) throw Error('Google authorization was not completed.');
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({ code, client_id: client.client_id, client_secret: client.client_secret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
      if (!tokenResponse.ok) throw Error(`Google authorization failed (HTTP ${tokenResponse.status}).`);
      const tokens = await responseJson(tokenResponse);
      if (!tokens.refresh_token || !tokens.access_token) throw Error('Google did not issue an offline refresh token. Revoke the old grant and reconnect.');
      const folderResponse = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { Authorization: `Bearer ${tokens.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Timekeeper recovery backups', mimeType: 'application/vnd.google-apps.folder' }) });
      if (!folderResponse.ok) throw Error(`Could not create the Google Drive backup folder (HTTP ${folderResponse.status}). Check that Drive API is enabled.`);
      const folder = await responseJson(folderResponse);
      if (!folder.id) throw Error('Google did not return a backup folder.');
      await output.writeFile(JSON.stringify({ clientId: client.client_id, clientSecret: client.client_secret, refreshToken: tokens.refresh_token, folderId: folder.id }, null, 2) + '\n');
      await output.sync(); completed = true;
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Connected. You can close this tab and return to your terminal.', complete);
    } catch (error) { res.writeHead(400, { 'Cache-Control': 'no-store' }); res.end('Setup did not complete. Check your terminal.', () => reject(error)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  redirectUri = `http://127.0.0.1:${server.address().port}/oauth2/callback`;
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.file',
    access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  console.log('Open this URL in a browser on this computer to connect your Google Drive:\n' + url);
  const timer = setTimeout(() => reject(Error('Google authorization timed out. Run setup again.')), 5 * 60_000);
  try { await finished; } finally { clearTimeout(timer); }
  console.log('Google backup credentials saved privately. Do not commit or share this file.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally {
  process.removeListener('SIGINT', interrupt);
  if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); }
  if (output) { await output.close(); if (!completed) await rm(resolve(outputPath), { force: true }); }
}
