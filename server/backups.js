import { DatabaseSync, backup } from 'node:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { backupAlerts } from './backup-alerts.js';
import { validBackup } from './validation.js';

const MAGIC = Buffer.from('TKBACKUP1\n');
const NAME = /^timekeeper-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.tkbackup$/;
export function parseBackupKey(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32 || key.toString('base64') !== text) throw Error('Backup encryption key must be a base64-encoded 32-byte key.');
  return key;
}
export async function loadBackupKey(env = process.env) {
  if (env.BACKUP_ENCRYPTION_KEY && env.BACKUP_KEY_FILE) throw Error('Use BACKUP_ENCRYPTION_KEY or BACKUP_KEY_FILE, not both.');
  return parseBackupKey(env.BACKUP_KEY_FILE ? await readFile(env.BACKUP_KEY_FILE, 'utf8') : env.BACKUP_ENCRYPTION_KEY);
}
export async function fileHash(path, algorithm = 'sha256') {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function inspectDatabase(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw Error('Backup database integrity check failed.');
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
    if (![2, 3, 4].includes(version)) throw Error('This backup tool supports schema versions 2, 3, and 4 only.');
    if (version >= 3) db.prepare('SELECT COUNT(*) FROM password_resets').get();
    if (version >= 4) db.prepare('SELECT COUNT(*) FROM audit_events').get();
    for (const table of ['users', 'memberships', 'workspaces', 'workspace_documents', 'sessions', 'invitations']) db.prepare(`SELECT COUNT(*) FROM ${table}`).get();
    for (const row of db.prepare('SELECT data FROM workspace_documents').iterate()) if (!validBackup(JSON.parse(row.data))) throw Error('Backup contains invalid workspace data.');
    const links = db.prepare(`SELECT m.employee_id, d.data, u.email FROM memberships m
      JOIN users u ON u.id=m.user_id JOIN workspace_documents d ON d.workspace_id=m.workspace_id`).iterate();
    for (const row of links) {
      const employee = JSON.parse(row.data).employees.find(e => e.id === row.employee_id);
      if (!employee?.active || employee.email.toLowerCase() !== row.email.toLowerCase()) throw Error('Backup contains an invalid account/employee link.');
    }
    if (db.prepare(`SELECT w.id FROM workspaces w LEFT JOIN memberships m ON m.workspace_id=w.id AND m.role='admin'
      LEFT JOIN workspace_documents d ON d.workspace_id=w.id GROUP BY w.id HAVING COUNT(m.user_id)=0 OR d.workspace_id IS NULL`).all().length) throw Error('Backup contains a workspace without an admin or data.');
    return { schemaVersion: version };
  } finally { db.close(); }
}

async function decryptArchive(archive, key, target) {
  const handle = await open(archive, 'r');
  let header, raw, offset, size;
  try {
    size = (await handle.stat()).size;
    const prefix = Buffer.alloc(MAGIC.length + 4);
    await handle.read(prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw Error('Not a Timekeeper recovery archive.');
    const length = prefix.readUInt32BE(MAGIC.length);
    if (length < 1 || length > 4096 || size <= prefix.length + length + 16) throw Error('Invalid recovery archive header.');
    raw = Buffer.alloc(length); await handle.read(raw, 0, length, prefix.length);
    header = JSON.parse(raw.toString()); offset = prefix.length + length;
    if (header.version !== 1 || ![2, 3, 4].includes(header.schemaVersion) || !Number.isSafeInteger(header.bytes) || header.bytes <= 0 || !/^[a-f0-9]{64}$/.test(header.sha256) || typeof header.iv !== 'string' || Buffer.from(header.iv, 'base64').length !== 12 || !Number.isFinite(Date.parse(header.createdAt))) throw Error('Invalid recovery archive metadata.');
    if (size - offset - 16 !== header.bytes) throw Error('Recovery archive is truncated or has an invalid length.');
    const tag = Buffer.alloc(16); await handle.read(tag, 0, 16, size - 16);
    const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(header.iv, 'base64'));
    cipher.setAAD(raw); cipher.setAuthTag(tag);
    await pipeline(createReadStream(archive, { start: offset, end: size - 17 }), cipher, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
    if (await fileHash(target) !== header.sha256) throw Error('Recovered database checksum does not match.');
    inspectDatabase(target);
    return header;
  } catch (error) {
    if (error.code === 'ERR_OSSL_EVP_BAD_DECRYPT' || /authenticate data/.test(error.message)) throw Error('Cannot decrypt backup: wrong key or damaged archive.');
    throw error;
  } finally { await handle.close(); }
}

export async function verifyArchive(archive, key) {
  const temporary = await mkdtemp(join(tmpdir(), 'timekeeper-verify-'));
  try { return await decryptArchive(archive, key, join(temporary, 'verified.sqlite')); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function listArchives(directory) {
  try { return (await readdir(directory)).filter(name => NAME.test(name)).sort().reverse(); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function createArchive(db, directory, key) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, '.creating-'));
  try {
    const snapshot = join(temporary, 'snapshot.sqlite');
    // SQLite's online backup includes committed WAL data without copying live files.
    await backup(db, snapshot);
    const info = inspectDatabase(snapshot), iv = randomBytes(12);
    const createdAt = new Date().toISOString();
    const raw = Buffer.from(JSON.stringify({ version: 1, createdAt, ...info, bytes: (await stat(snapshot)).size, sha256: await fileHash(snapshot), iv: iv.toString('base64') }));
    const length = Buffer.alloc(4); length.writeUInt32BE(raw.length);
    const encrypted = join(temporary, 'archive.partial');
    await writeFile(encrypted, Buffer.concat([MAGIC, length, raw]), { flag: 'wx', mode: 0o600 });
    const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(raw);
    await pipeline(createReadStream(snapshot), cipher, createWriteStream(encrypted, { flags: 'a' }));
    const handle = await open(encrypted, 'a');
    try { await handle.write(cipher.getAuthTag()); await handle.sync(); } finally { await handle.close(); }
    // A backup isn't published or eligible for retention until it decrypts and verifies.
    await verifyArchive(encrypted, key);
    const name = `timekeeper-${createdAt.replaceAll(':', '-').replace('.', '-')}-${randomUUID()}.tkbackup`;
    const path = join(directory, name); await rename(encrypted, path);
    return { name, path, createdAt, bytes: (await stat(path)).size };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function pruneArchives(directory, retain, protectedName) {
  if (!Number.isInteger(retain) || retain < 1 || retain > 30 || !NAME.test(protectedName)) throw Error('Invalid backup retention settings.');
  const names = await listArchives(directory);
  const keep = new Set([protectedName, ...names.filter(name => name !== protectedName).slice(0, retain - 1)]);
  for (const name of names) if (!keep.has(name)) await rm(join(directory, name));
}

export async function restoreArchive(archive, key, targetDirectory) {
  const target = resolve(targetDirectory);
  // An existing directory is refused even if empty: never replace a running database.
  await mkdir(target, { mode: 0o700 });
  let completed = false;
  try {
    const path = join(target, 'timekeeper.sqlite');
    const metadata = await decryptArchive(archive, key, path);
    const db = new DatabaseSync(path);
    try {
      db.exec(`BEGIN; DELETE FROM sessions; UPDATE invitations SET revoked_at = ${Date.now()} WHERE accepted_at IS NULL AND revoked_at IS NULL; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);`);
    } finally { db.close(); }
    if (metadata.schemaVersion >= 3) {
      const resetDb = new DatabaseSync(path);
      try { resetDb.exec('DELETE FROM password_resets; PRAGMA wal_checkpoint(TRUNCATE);'); } finally { resetDb.close(); }
    }
    inspectDatabase(path); completed = true;
    return { ...metadata, directory: target };
  } finally { if (!completed) await rm(target, { recursive: true, force: true }); }
}

export async function backupOptions(env, dataDir) {
  if (!env.BACKUP_ENABLED || env.BACKUP_ENABLED === 'false') return null;
  if (env.BACKUP_ENABLED !== 'true') throw Error('BACKUP_ENABLED must be true or false.');
  const hours = Number(env.BACKUP_INTERVAL_HOURS || 24), retain = Number(env.BACKUP_RETAIN || 7);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168 || !Number.isInteger(retain) || retain < 1 || retain > 30) throw Error('Backups require an interval of 1–168 hours and retention of 1–30 archives.');
  return { directory: resolve(env.BACKUP_DIR || join(dataDir, 'backups')), key: await loadBackupKey(env), intervalMs: hours * 3600_000, retain,
    operators: (env.BACKUP_OPERATOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean) };
}

export function backupService(db, config, { destination = null, now = Date.now, autoStart = true, logger = console } = {}) {
  let running = null, timer = null, stopped = false;
  const alerts = config?.alerts ? backupAlerts({ ...config.alerts, directory: config.directory, now, logger }) : null;
  let state = { lastSuccessAt: null, lastLocalAt: null, lastOffsiteAt: null, lastErrorAt: null, error: null, name: null, destinationId: destination?.identity || null };
  const intervalMs = config?.intervalMs || 24 * 3600_000;
  // Keep the initial deadline fixed: comparing two advancing 'now' calls can skip the first run.
  const initialDueAt = now();
  const dueAt = () => state.error && state.lastErrorAt ? Date.parse(state.lastErrorAt) + 15 * 60_000 : state.lastSuccessAt ? Date.parse(state.lastSuccessAt) + intervalMs : initialDueAt;
  const status = () => ({ enabled: Boolean(config), intervalHours: intervalMs / 3600_000, retain: config?.retain || 0, running: Boolean(running),
    offsiteConfigured: Boolean(destination), alerts: alerts?.status() || { enabled: false }, ...Object.fromEntries(['lastSuccessAt', 'lastLocalAt', 'lastOffsiteAt', 'lastErrorAt', 'error'].map(k => [k, state[k]])),
    nextRunAt: config ? new Date(dueAt()).toISOString() : null });
  async function persist() {
    const path = join(config.directory, 'backup-status.json');
    const partial = `${path}.${randomUUID()}.partial`;
    await writeFile(partial, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); await rename(partial, path);
  }
  async function initialize() {
    if (!config) return;
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(join(config.directory, 'backup-status.json'), 'utf8'));
      if (saved.destinationId !== state.destinationId) return;
      if (NAME.test(saved.name) && (await listArchives(config.directory)).includes(saved.name)) {
        await verifyArchive(join(config.directory, saved.name), config.key);
        if (saved.lastSuccessAt === null || (Number.isFinite(Date.parse(saved.lastSuccessAt)) && Date.parse(saved.lastSuccessAt) <= now())) {
          for (const field of ['lastSuccessAt', 'lastLocalAt', 'lastOffsiteAt', 'lastErrorAt']) if (saved[field] !== null && !Number.isFinite(Date.parse(saved[field]))) throw Error('Invalid backup checkpoint.');
          state = { ...state, ...saved };
        }
      }
    } catch { /* A missing or unverifiable checkpoint triggers a fresh snapshot. */ }
  }
  const ready = initialize().catch(error => {
    state.lastErrorAt = new Date(now()).toISOString();
    state.error = 'Backup storage could not be initialized. The server operator must check configuration and storage, then restart the service.';
    logger.error('Recovery backup initialization failed:', error.code || 'BACKUP_INIT_FAILED');
    throw error;
  });
  function run({ fresh = false } = {}) {
    if (!config) return Promise.reject(Error('Server backups are not enabled.'));
    if (stopped) return Promise.reject(Error('Backup service is stopping.'));
    if (running) return fresh ? running.catch(() => {}).then(() => run({ fresh: true })) : running;
    running = (async () => {
      try {
        await ready;
        let archive;
        const pendingUpload = destination && state.name && state.lastLocalAt && (!state.lastSuccessAt || Date.parse(state.lastLocalAt) > Date.parse(state.lastSuccessAt));
        if (!fresh && pendingUpload && now() - Date.parse(state.lastLocalAt) < intervalMs) {
          try {
            const path = join(config.directory, state.name), metadata = await verifyArchive(path, config.key);
            archive = { name: state.name, path, createdAt: metadata.createdAt, bytes: (await stat(path)).size };
          } catch { /* Rebuild a missing or damaged pending copy from the source database. */ }
        }
        if (!archive) {
          archive = await createArchive(db, config.directory, config.key);
          state.lastLocalAt = new Date(now()).toISOString(); state.name = archive.name;
          await persist(); await pruneArchives(config.directory, config.retain, archive.name);
        }
        if (destination) { await destination.upload(archive, config.retain); state.lastOffsiteAt = new Date(now()).toISOString(); }
        state.lastSuccessAt = new Date(now()).toISOString(); state.error = null;
        await persist();
        return archive;
      } catch (error) {
        state.lastErrorAt = new Date(now()).toISOString(); state.error = 'Backup did not complete. The server operator should check backup configuration, storage, and logs.';
        const explanations = { ENOSPC: 'Backup failed: the server disk is full.', EACCES: 'Backup failed: the backup directory is not writable.',
          R2_BACKUP_FAILED: 'R2 backup failed. Check bucket credentials, permissions, connectivity, and storage status.',
          GOOGLE_AUTH_FAILED: 'Google backup authentication failed. The server operator must reconnect the Google account.',
          GOOGLE_UPLOAD_FAILED: 'Google backup upload failed. Check folder access, storage quota, and service connectivity.',
          GOOGLE_CHECKSUM_FAILED: 'Google backup upload did not pass its checksum check. Older Google copies were kept.',
          GOOGLE_RETENTION_FAILED: 'Google backup retention cleanup did not complete. Check Google access and backup status.' };
        if (explanations[error.code]) state.error = explanations[error.code];
        await persist().catch(() => {});
        logger.error('Recovery backup failed:', error.code || 'BACKUP_FAILED');
        throw error;
      } finally {
        await alerts?.check(status());
        running = null;
      }
    })();
    return running;
  }
  async function checkDue() {
    if (!config || stopped) return;
    try {
      await ready;
      if (now() >= dueAt()) await run();
    } catch { /* Status and logs retain failures; don't take down the application. */ }
    await alerts?.check(status());
  }
  async function tick() {
    await checkDue();
    if (!stopped) { timer = setTimeout(tick, 60_000); timer.unref(); }
  }
  if (autoStart && config) void tick();
  return { run, status, ready, checkDue, testAlert: () => {
    if (!alerts) throw Error('Backup email alerts are not enabled.');
    return alerts.test();
  }, isOperator: session => Boolean(config && session.role === 'admin' && config.operators.includes(session.email.toLowerCase())),
    async stop() { stopped = true; clearTimeout(timer); if (running) await running.catch(() => {}); await ready.catch(() => {}); await alerts?.stop(); } };
}
