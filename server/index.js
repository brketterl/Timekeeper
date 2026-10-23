import { createServer } from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { accessStore } from './access.js';
import { backupOptions, backupService } from './backups.js';
import { r2BackupOptions, r2Destination } from './r2-backups.js';
import { googleBackupOptions, googleDriveDestination } from './google-backups.js';

const scrypt = promisify(scryptCallback);
const digest = token => createHash('sha256').update(token).digest('hex');
const lifetime = 7 * 24 * 60 * 60 * 1000;
const dummyHash = '00'.repeat(64);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}
async function checkPassword(password, stored = `dummy:${dummyHash}`) {
  const [salt, expected] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415, 'Use JSON requests.');
  let size = 0, chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5_000_000) throw fail(413, 'Request is too large.');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid object');
    return value;
  }
  catch { throw fail(400, 'Invalid JSON.'); }
}

export function createApp({ dataDir = resolve(process.env.DATA_DIR || '.data'), secureCookies = process.env.NODE_ENV === 'production', allowedOrigin = process.env.APP_ORIGIN, backupConfig = null } = {}) {
  if (secureCookies && !allowedOrigin) throw Error('APP_ORIGIN is required in production.');
  if (allowedOrigin) {
    const origin = new URL(allowedOrigin);
    if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw Error('APP_ORIGIN must be an HTTP(S) origin without a path.');
    if (secureCookies && origin.protocol !== 'https:') throw Error('Production requires an HTTPS APP_ORIGIN.');
    allowedOrigin = origin.origin;
  }
  const db = openDatabase(dataDir);
  const attempts = new Map();
  const access = accessStore(db);
  const recovery = backupService(db, backupConfig, { destination: backupConfig?.destination });
  function checkAuthLimit(req) {
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
    const key = req.socket.remoteAddress;
    const entry = attempts.get(key) || { count: 0, until: now + 15 * 60_000 };
    if (++entry.count > 20) throw fail(429, 'Too many attempts. Try again in 15 minutes.');
    attempts.set(key, entry);
  }
  const cookie = (token, maxAge) => `timekeeper_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`;
  function issueSession(res, userId, workspaceId) {
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(digest(token), userId, workspaceId, Date.now() + lifetime);
    res.setHeader('Set-Cookie', cookie(token, lifetime / 1000));
  }
  const server = createServer(async (req, res) => {
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && path === '/health') return send(200, { status: db.prepare('SELECT 1 AS ok').get().ok === 1 ? 'ok' : 'error' });
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = await readFile(new URL('../public/index.html', import.meta.url));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(html);
      }
      if (req.method === 'GET' && ['/auth.js', '/access.js', '/backups.js'].includes(path)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        return res.end(await readFile(new URL(`../public${path}`, import.meta.url)));
      }
      if (!path.startsWith('/api/')) throw fail(404, 'Not found.');
      if (!['GET', 'HEAD'].includes(req.method)) {
        const expectedOrigin = allowedOrigin || `http://${req.headers.host}`;
        if (req.headers.origin !== expectedOrigin) throw fail(403, 'Request origin is not allowed.');
      }
      if (req.method === 'POST' && ['/api/auth/register', '/api/auth/login', '/api/invitations/preview'].includes(path)) {
        const now = Date.now();
        checkAuthLimit(req);
        const input = await body(req);
        if (path === '/api/invitations/preview') {
          const invite = access.invitation(input.token);
          return send(200, { email: invite.email, role: invite.role, workspaceName: invite.workspace_name });
        }
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        const password = input.password;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof password !== 'string' || password.length > 256) throw fail(400, 'Enter a valid email and password.');
        if (path.endsWith('/register')) {
          const name = typeof input.name === 'string' ? input.name.trim() : '';
          if (!name || name.length > 100 || password.length < 12) throw fail(400, 'Provide your name and a password of at least 12 characters.');
          const passwordHash = await hashPassword(password);
          const userId = randomUUID();
          let workspaceId = randomUUID();
          const data = { version: 2, demo: false, settings: { business: `${name}'s business`, email, address: '', paymentNote: 'Thank you for your business.', schedule: 'semimonthly' }, employees: [{ id: userId, name, email, active: true, contracts: [] }], contracts: [], sheets: [], invoices: [] };
          db.exec('BEGIN');
          try {
            if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) throw fail(409, 'An account with that email already exists.');
            db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(userId, email, name, passwordHash, now);
            if (input.inviteToken) {
              workspaceId = access.join(access.invitation(input.inviteToken), { id: userId, email, name });
            } else {
              db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run(workspaceId, data.settings.business, now);
              db.prepare('INSERT INTO memberships VALUES (?, ?, ?, ?)').run(userId, workspaceId, 'admin', userId);
              db.prepare('INSERT INTO workspace_documents VALUES (?, ?, 0, ?)').run(workspaceId, JSON.stringify(data), now);
            }
            db.exec('COMMIT');
          } catch (e) { db.exec('ROLLBACK'); throw e; }
          issueSession(res, userId, workspaceId);
          return send(201, { user: { id: userId, email, name } });
        }
        const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (!await checkPassword(password, user?.password_hash) || !user) throw fail(401, 'Email or password is incorrect.');
        const membership = input.inviteToken
          ? { workspace_id: access.transaction(() => access.join(access.invitation(input.inviteToken), user)) }
          : db.prepare('SELECT workspace_id FROM memberships WHERE user_id = ? ORDER BY workspace_id LIMIT 1').get(user.id);
        if (!membership) throw fail(403, 'No workspace membership is available.');
        issueSession(res, user.id, membership.workspace_id);
        return send(200, { user: { id: user.id, name: user.name, email: user.email } });
      }
      const token = /(?:^|;\s*)timekeeper_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
      const session = token && db.prepare(`SELECT s.*, u.name, u.email, m.role, m.employee_id FROM sessions s
        JOIN users u ON u.id = s.user_id JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
        WHERE token_hash = ? AND expires_at > ?`).get(digest(token), Date.now());
      if (!session) throw fail(401, 'Please sign in.');
      if (req.method === 'GET' && path === '/api/backups/status') {
        if (session.role !== 'admin') throw fail(403, 'Admin access is required.');
        return send(200, { ...recovery.status(), canDownload: recovery.isOperator(session) });
      }
      if (req.method === 'POST' && path === '/api/backups/download') {
        if (!recovery.isOperator(session)) throw fail(403, 'Only the configured server backup operator can download recovery archives.');
        checkAuthLimit(req);
        const input = await body(req);
        if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 256) throw fail(400, 'Enter your current password.');
        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.user_id);
        if (!await checkPassword(input.currentPassword, user?.password_hash)) throw fail(401, 'Your current password is incorrect.');
        const checkOperator = () => {
          const current = db.prepare(`SELECT u.email, u.password_hash, m.role FROM sessions s JOIN users u ON u.id=s.user_id
            JOIN memberships m ON m.user_id=s.user_id AND m.workspace_id=s.workspace_id
            WHERE s.token_hash=? AND s.expires_at>?`).get(digest(token), Date.now());
          if (!current || current.password_hash !== user.password_hash || !recovery.isOperator(current)) throw fail(403, 'Backup operator access is no longer available.');
        };
        checkOperator();
        const archive = await recovery.run({ fresh: true });
        checkOperator();
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${archive.name}"`, 'Content-Length': archive.bytes });
        await pipeline(createReadStream(archive.path), res);
        return;
      }
      if (req.method === 'GET' && path === '/api/auth/me') return send(200, { user: { id: session.user_id, name: session.name, email: session.email }, role: session.role, employeeId: session.employee_id, workspaceId: session.workspace_id });
      if (req.method === 'PATCH' && path === '/api/auth/email') {
        checkAuthLimit(req);
        const input = await body(req);
        const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof input.currentPassword !== 'string' || input.currentPassword.length > 256) throw fail(400, 'Enter a valid email and your current password.');
        const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(session.user_id);
        if (!await checkPassword(input.currentPassword, user?.password_hash)) throw fail(401, 'Your current password is incorrect.');
        access.changeEmail(session, email, user.password_hash, digest(token));
        issueSession(res, session.user_id, session.workspace_id);
        return send(200, { email });
      }
      if (req.method === 'POST' && path === '/api/auth/logout') {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
        res.setHeader('Set-Cookie', cookie('', 0)); return send(200, { ok: true });
      }
      if (req.method === 'POST' && path === '/api/auth/switch') {
        const input = await body(req);
        const membership = db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?').get(session.user_id, input.workspaceId);
        if (!membership) throw fail(403, 'You do not belong to this workspace.');
        issueSession(res, session.user_id, input.workspaceId);
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
        return send(200, { ok: true });
      }
      const input = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await body(req) : {};
      const result = await access.route(path, req.method, session, input);
      if (path === '/api/invitations/accept') {
        issueSession(res, session.user_id, result.workspaceId);
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(digest(token));
      }
      return send(200, result);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      if (!e.status) console.error('Request failed:', e.message);
      send(e.status || 500, { error: e.status ? e.message : 'An internal error occurred.' });
    }
  });
  let resourcesClosing;
  server.once('close', () => { resourcesClosing = recovery.stop().finally(() => db.close()); });
  const closeHttp = server.close;
  server.close = function (callback) {
    return closeHttp.call(server, error => { Promise.resolve(resourcesClosing).then(() => callback?.(error), failure => callback?.(failure)); });
  };
  return server;
}

export function deploymentOptions(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('PORT must be an integer from 1 to 65535.');
  return {
    port, host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    dataDir: resolve(env.DATA_DIR || '.data'), secureCookies: production,
    allowedOrigin: env.APP_ORIGIN || env.RENDER_EXTERNAL_URL
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { port, host, ...options } = deploymentOptions();
  const backupConfig = await backupOptions(process.env, options.dataDir);
  if (backupConfig) {
    const googleConfig = await googleBackupOptions();
    const r2Config = await r2BackupOptions();
    if (googleConfig && r2Config) throw Error('Configure only one off-site backup destination: Google Drive or R2.');
    if (r2Config) backupConfig.destination = r2Destination(r2Config);
    else if (googleConfig) backupConfig.destination = googleDriveDestination(googleConfig);
  }
  const server = createApp({ ...options, backupConfig });
  server.listen(port, host, () => console.log(`Timekeeper listening on ${host}:${port}`));
  const shutdown = () => {
    server.close(() => { process.exitCode = 0; });
    setTimeout(() => server.closeAllConnections(), 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
