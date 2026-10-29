import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, scryptSync, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { openDatabase } from '../server/db.js';
import { createApp } from '../server/index.js';
import { createArchive, verifyArchive, restoreArchive, listArchives, pruneArchives, backupService, backupOptions, parseBackupKey } from '../server/backups.js';
import { googleDriveDestination, googleBackupOptions } from '../server/google-backups.js';

const password = 'backup integration test password';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'timekeeper-backup-test-'));
  const dataDir = join(root, 'data'), directory = join(root, 'archives'), key = randomBytes(32);
  const db = openDatabase(dataDir);
  const passwordHash = 'test-salt:' + scryptSync(password, 'test-salt', 64).toString('hex');
  const accounts = [['admin', 'admin@example.test'], ['employee', 'employee@example.test'], ['other', 'other@example.test']];
  for (const [id, email] of accounts) db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, email, id, passwordHash, Date.now());
  for (const [workspace, admin] of [['one', 'admin'], ['two', 'other']]) {
    const email = accounts.find(a => a[0] === admin)[1];
    const data = { version: 2, demo: false, settings: { business: 'Backup business ' + workspace, email: '', address: '', paymentNote: '', schedule: 'semimonthly' }, employees: [{ id: admin, name: admin, email, active: true, contracts: [] }], contracts: [], sheets: [], invoices: [] };
    if (workspace === 'one') {
      data.employees.push({ id: 'employee', name: 'Employee', email: 'employee@example.test', active: true, contracts: ['contract'] });
      data.contracts.push({ id: 'contract', name: 'Services', client: 'Client', email: '', address: '', rate: 12500, budget: 100, active: true });
      data.sheets.push({ id: 'sheet', employeeId: 'employee', start: '2026-10-01', status: 'approved', rows: [{ id: 'row', contractId: 'contract', status: 'approved', rate: 12500, hours: { '2026-10-01': 8 }, note: 'Actual work' }] });
      data.invoices.push({ id: 'invoice', number: 'INV-1001', contractId: 'contract', client: 'Client', contract: 'Services', email: '', address: '', business: { ...data.settings }, issued: '2026-10-02', due: '2026-10-31', sentDate: '2026-10-02', lines: [{ sources: [{ sheetId: 'sheet', rowId: 'row' }], description: 'Services', employee: 'Employee', start: '2026-10-01', end: '2026-10-15', hours: 8, rate: 12500, amount: 100000 }], payments: [{ id: 'payment', date: '2026-10-03', amount: 100000, reference: 'Paid' }], note: '' });
    }
    db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(workspace, data.settings.business, Date.now());
    db.prepare('INSERT INTO workspace_documents VALUES(?,?,?,?)').run(workspace, JSON.stringify(data), 3, Date.now());
    db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(admin, workspace, 'admin', admin);
  }
  db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run('employee', 'one', 'employee', 'employee');
  db.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('old-session', 'admin', 'one', Date.now() + 100000);
  db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?,?,?,?,?,?)').run('pending', 'one', 'pending@example.test', 'employee', null, 'invite-hash', 'admin', Date.now() + 100000, null, null);
  t.after(async () => { if (db.isOpen) db.close(); await rm(root, { recursive: true, force: true }); });
  return { root, db, dataDir, directory, key };
}

test('online encrypted snapshots recover committed WAL data, logins, memberships and invoices', async t => {
  const f = await fixture(t);
  f.db.exec('PRAGMA wal_autocheckpoint=0');
  assert((await stat(join(f.dataDir, 'timekeeper.sqlite-wal'))).size > 0);
  const archive = await createArchive(f.db, f.directory, f.key);
  assert(!(await readFile(archive.path)).includes(Buffer.from('admin@example.test')));
  const metadata = await verifyArchive(archive.path, f.key); assert.equal(metadata.schemaVersion, 3);
  const restoredPath = join(f.root, 'restored'); await restoreArchive(archive.path, f.key, restoredPath);
  const recovered = new DatabaseSync(join(restoredPath, 'timekeeper.sqlite'));
  try {
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM memberships').get().n, 3);
    assert.equal(recovered.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert(recovered.prepare('SELECT revoked_at FROM invitations').get().revoked_at);
    for (const workspace of ['one', 'two']) {
      const expected = f.db.prepare('SELECT data FROM workspace_documents WHERE workspace_id=?').get(workspace);
      assert.equal(recovered.prepare('SELECT data FROM workspace_documents WHERE workspace_id=?').get(workspace).data, expected.data);
    }
  } finally { recovered.close(); }
  const server = createApp({ dataDir: restoredPath, secureCookies: false, allowedOrigin: null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const login = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password }) });
    assert.equal(login.status, 200);
    const result = await fetch(origin + '/api/workspace', { headers: { Cookie: login.headers.get('set-cookie').split(';')[0] } });
    const workspace = await result.json(); assert.equal(workspace.data.invoices[0].payments[0].amount, 100000);
  } finally { await new Promise(r => server.close(r)); }
});

test('schema-3 restore clears reset links and schema-2 archives still upgrade safely', async t => {
  const f = await fixture(t);
  f.db.prepare('INSERT INTO password_resets VALUES(?,?,?,?,?,?)').run('hashed-token', 'admin', 'admin@example.test', 'credential-fingerprint', Date.now(), Date.now() + 1800_000);
  const archive = await createArchive(f.db, f.directory, f.key), target = join(f.root, 'restored-v3');
  await restoreArchive(archive.path, f.key, target);
  const restored = new DatabaseSync(join(target, 'timekeeper.sqlite'));
  assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM password_resets').get().n, 0); restored.close();
  // A real schema-2 snapshot models archives produced before the migration.
  f.db.exec('DROP TABLE password_resets; DELETE FROM schema_migrations WHERE version=3;');
  const oldArchive = await createArchive(f.db, f.directory, f.key);
  assert.equal((await verifyArchive(oldArchive.path, f.key)).schemaVersion, 2);
  const oldTarget = join(f.root, 'restored-v2'); await restoreArchive(oldArchive.path, f.key, oldTarget);
  const upgraded = openDatabase(oldTarget);
  assert.equal(upgraded.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n, 3);
  assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3); upgraded.close();
});

test('wrong keys, tampering, truncation, and existing restore destinations are rejected', async t => {
  const f = await fixture(t); const archive = await createArchive(f.db, f.directory, f.key);
  await assert.rejects(verifyArchive(archive.path, randomBytes(32)));
  const bad = Buffer.from(await readFile(archive.path)); bad[bad.length - 20] ^= 1;
  const corrupt = join(f.root, 'corrupt'); await writeFile(corrupt, bad);
  await assert.rejects(restoreArchive(corrupt, f.key, join(f.root, 'failed-restore')));
  await assert.rejects(stat(join(f.root, 'failed-restore')), { code: 'ENOENT' });
  await writeFile(corrupt, bad.subarray(0, 30)); await assert.rejects(verifyArchive(corrupt, f.key));
  const existing = join(f.root, 'existing'); await mkdir(existing); await writeFile(join(existing, 'keep'), 'keep');
  await assert.rejects(restoreArchive(archive.path, f.key, existing), { code: 'EEXIST' });
  assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'keep');
});

test('retention only removes managed archives after a verified replacement', async t => {
  const f = await fixture(t), archives = [];
  for (let i = 0; i < 3; i++) archives.push(await createArchive(f.db, f.directory, f.key));
  await writeFile(join(f.directory, 'unrelated.sqlite'), 'user file');
  await pruneArchives(f.directory, 2, archives[2].name);
  assert.equal((await listArchives(f.directory)).length, 2);
  assert.equal(await readFile(join(f.directory, 'unrelated.sqlite'), 'utf8'), 'user file');
  f.db.close(); await assert.rejects(createArchive(f.db, f.directory, f.key));
  assert.equal((await listArchives(f.directory)).length, 2);
  await assert.rejects(pruneArchives(f.directory, 0, archives[2].name));
});

test('daily schedule, retries, restart checkpoint, and destination changes are tracked', async t => {
  const f = await fixture(t);
  let time = Date.now(), uploads = 0, failUpload = false; const uploadedNames = [];
  const destination = { identity: 'google-folder-one', async upload(archive) { uploads++; uploadedNames.push(archive.name); if (failUpload) throw Error('test upload failure'); } };
  const config = { directory: f.directory, key: f.key, retain: 2, intervalMs: 24 * 3600_000, operators: ['admin@example.test'] };
  const errors = [];
  const service = backupService(f.db, config, { destination, now: () => time, autoStart: false, logger: { error: (...args) => errors.push(args.join(' ')) } });
  await service.checkDue(); assert.equal(uploads, 1); assert(service.status().lastOffsiteAt);
  time += config.intervalMs - 1; await service.checkDue(); assert.equal(uploads, 1);
  failUpload = true; time++; await service.checkDue(); assert.equal(uploads, 2); assert(service.status().error);
  assert(errors.some(message => message.includes('BACKUP_FAILED')));
  assert.equal((await listArchives(f.directory)).length, 2);
  time += 14 * 60_000; await service.checkDue(); assert.equal(uploads, 2);
  failUpload = false; time += 60_000; await service.checkDue(); assert.equal(uploads, 3); assert.equal(service.status().error, null);
  assert.equal(uploadedNames[2], uploadedNames[1]);
  assert.equal((await listArchives(f.directory)).length, 2); await service.stop();
  const restarted = backupService(f.db, config, { destination, now: () => time, autoStart: false });
  await restarted.ready; assert(restarted.status().lastSuccessAt); await restarted.checkDue(); assert.equal(uploads, 3); await restarted.stop();
  const changed = backupService(f.db, config, { destination: { ...destination, identity: 'different-folder' }, now: () => time, autoStart: false });
  await changed.ready; assert.equal(changed.status().lastSuccessAt, null); await changed.stop();
});

test('manual downloads queue a fresh snapshot after an in-progress scheduled backup', async t => {
  const f = await fixture(t);
  let release, reached;
  const gate = new Promise(r => { release = r; }), started = new Promise(r => { reached = r; });
  let uploads = 0;
  const config = { directory: f.directory, key: f.key, retain: 2, intervalMs: 86400_000, operators: [] };
  const service = backupService(f.db, config, { autoStart: false, destination: { identity: 'test', async upload() { if (++uploads === 1) { reached(); await gate; } } } });
  const scheduled = service.run(); await started;
  assert.equal(service.run(), scheduled);
  const document = JSON.parse(f.db.prepare("SELECT data FROM workspace_documents WHERE workspace_id='one'").get().data);
  document.settings.business = 'Saved after scheduled snapshot';
  f.db.prepare("UPDATE workspace_documents SET data=? WHERE workspace_id='one'").run(JSON.stringify(document));
  const manual = service.run({ fresh: true }); release();
  const [before, after] = await Promise.all([scheduled, manual]);
  assert.notEqual(before.name, after.name);
  const target = join(f.root, 'fresh-restore'); await restoreArchive(after.path, f.key, target);
  const restored = new DatabaseSync(join(target, 'timekeeper.sqlite'));
  try { assert.equal(JSON.parse(restored.prepare("SELECT data FROM workspace_documents WHERE workspace_id='one'").get().data).settings.business, 'Saved after scheduled snapshot'); }
  finally { restored.close(); await service.stop(); }
});

test('configuration requires real encryption keys and complete Google credentials', async () => {
  assert.equal(await backupOptions({}, '/tmp/data'), null);
  await assert.rejects(backupOptions({ BACKUP_ENABLED: 'true' }, '/tmp/data'));
  assert.throws(() => parseBackupKey('not-a-key'));
  const env = { BACKUP_ENABLED: 'true', BACKUP_ENCRYPTION_KEY: randomBytes(32).toString('base64'), BACKUP_OPERATOR_EMAILS: ' Admin@example.test ' };
  const options = await backupOptions(env, '/tmp/data'); assert.equal(options.intervalMs, 86400_000); assert.deepEqual(options.operators, ['admin@example.test']);
  await assert.rejects(backupOptions({ ...env, BACKUP_RETAIN: '0' }, '/tmp/data'));
  assert.equal(await googleBackupOptions({}), null);
  await assert.rejects(googleBackupOptions({ GOOGLE_BACKUP_CLIENT_ID: 'only-one-field' }));
});

test('CLI generates private non-overwriting keys and verifies and restores archives', async t => {
  const f = await fixture(t), run = promisify(execFile), keyFile = join(f.root, 'backup.key');
  const command = args => run(process.execPath, ['scripts/backups.js', ...args], { cwd: process.cwd(), env: { ...process.env, DATA_DIR: f.dataDir, BACKUP_DIR: f.directory, BACKUP_KEY_FILE: keyFile, BACKUP_ENCRYPTION_KEY: '' } });
  await command(['keygen', keyFile]);
  assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  await assert.rejects(command(['keygen', keyFile]));
  await command(['create']); const [name] = await listArchives(f.directory);
  assert.match((await command(['verify', join(f.directory, name)])).stdout, /passes database checks/);
  await command(['restore', join(f.directory, name), join(f.root, 'cli-restored')]);
});

test('Google uploads ciphertext, verifies receipt and paginates before scoped retention', async t => {
  const f = await fixture(t), archive = await createArchive(f.db, f.directory, f.key), deleted = [];
  const older = archive.name.replace(/timekeeper-\d{4}/, 'timekeeper-2019');
  const newer = archive.name.replace(/timekeeper-\d{4}/, 'timekeeper-2020');
  let uploadBody;
  const fakeFetch = async (url, options = {}) => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'mock-token' });
    if (url.includes('uploadType=resumable')) return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' } });
    if (options.method === 'PUT') {
      const chunks = []; for await (const chunk of options.body) chunks.push(chunk); uploadBody = Buffer.concat(chunks);
      return Response.json({ id: 'new', size: String(uploadBody.length), md5Checksum: createHash('md5').update(uploadBody).digest('hex') });
    }
    if (options.method === 'DELETE') { deleted.push(url.split('/').at(-1)); return new Response(null, { status: 204 }); }
    if (url.includes('pageToken=next')) return Response.json({ files: [{ id: 'latest-old', name: newer }] });
    return Response.json({ nextPageToken: 'next', files: [{ id: 'oldest', name: older }, { id: 'unrelated', name: 'notes.txt' }] });
  };
  const config = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', folderId: 'folder' };
  await googleDriveDestination(config, { fetchImpl: fakeFetch }).upload(archive, 2);
  assert(uploadBody.equals(await readFile(archive.path))); assert.deepEqual(deleted, ['oldest']);
  assert(!uploadBody.includes(Buffer.from('admin@example.test')));
  let cleanupCalled = false;
  const corruptedReceipt = async (url, options = {}) => {
    if (options.method === 'DELETE') cleanupCalled = true;
    const response = await fakeFetch(url, options);
    if (options.method === 'PUT') return Response.json({ id: 'new', size: String(archive.bytes), md5Checksum: 'bad' });
    return response;
  };
  await assert.rejects(googleDriveDestination(config, { fetchImpl: corruptedReceipt }).upload(archive, 2), /checksum/);
  assert.equal(cleanupCalled, false);
});

test('recovery downloads require a configured server operator, password and same-origin request', async t => {
  const f = await fixture(t);
  const server = createApp({
    dataDir: f.dataDir, secureCookies: false, allowedOrigin: null,
    backupConfig: { directory: f.directory, key: f.key, retain: 2, intervalMs: 86400_000, operators: ['admin@example.test'] }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = async email => {
    const response = await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 200); return response.headers.get('set-cookie').split(';')[0];
  };
  const download = (cookie, currentPassword = password, requestOrigin = origin) => fetch(origin + '/api/backups/download', { method: 'POST', headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword }) });
  try {
    const admin = await login('admin@example.test'), employee = await login('employee@example.test'), otherAdmin = await login('other@example.test');
    assert.equal((await fetch(origin + '/api/backups/status')).status, 401);
    assert.equal((await fetch(origin + '/api/backups/status', { headers: { Cookie: employee } })).status, 403);
    const status = await (await fetch(origin + '/api/backups/status', { headers: { Cookie: otherAdmin } })).json();
    assert.equal(status.canDownload, false); assert.equal(status.offsiteConfigured, false);
    assert.equal(JSON.stringify(status).includes(f.key.toString('base64')), false);
    assert.equal((await download(employee)).status, 403); assert.equal((await download(otherAdmin)).status, 403);
    assert.equal((await download(admin, password, 'https://attacker.example')).status, 403);
    assert.equal((await download(admin, 'wrong')).status, 401);
    const response = await download(admin); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /\.tkbackup/);
    const path = join(f.root, 'downloaded.tkbackup'); await writeFile(path, Buffer.from(await response.arrayBuffer()));
    await verifyArchive(path, f.key);
  } finally { await new Promise(r => server.close(r)); }
});

test('email outages never turn a verified backup into a failure', async t => {
  const f = await fixture(t); let failUpload = true;
  const service = backupService(f.db, { directory: f.directory, key: f.key, retain: 2, intervalMs: 86400_000, operators: [],
    alerts: { send: async () => { throw Error('email provider down'); } } },
    { autoStart: false, logger: { error() {} }, destination: { identity: 'test', upload: async () => { if (failUpload) throw Error('upload down'); } } });
  await assert.rejects(service.run(), /upload down/);
  assert.match(service.status().alerts.error, /delivery failed/);
  failUpload = false; await service.run();
  assert.equal(service.status().error, null); assert(service.status().lastOffsiteAt);
  await service.stop();
});

test('scheduler checks overdue alerts even when a weekly backup is not due', async t => {
  const f = await fixture(t); let clock = Date.now(); const sent = [];
  const service = backupService(f.db, { directory: f.directory, key: f.key, retain: 2, intervalMs: 168 * 3600_000, operators: [],
    alerts: { send: async email => sent.push(email) } },
    { autoStart: false, now: () => clock, logger: { error() {} }, destination: { identity: 'weekly-test', upload: async () => {} } });
  await service.run(); assert.equal(sent.length, 0);
  clock += 48 * 3600_000; await service.checkDue();
  assert.equal(sent.length, 1); assert.match(sent[0].subject, /overdue/);
  await service.stop();
});

test('test-alert endpoint enforces operator role, current password, origin, and fixed message', async t => {
  const f = await fixture(t), sent = [];
  const server = createApp({ dataDir: f.dataDir, secureCookies: false, allowedOrigin: null,
    backupConfig: { directory: f.directory, key: f.key, retain: 2, intervalMs: 86400_000, operators: ['admin@example.test'],
      alerts: { send: async email => sent.push(email) } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = async email => (await fetch(origin + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).headers.get('set-cookie').split(';')[0];
  const request = (cookie, currentPassword = password, requestOrigin = origin) => fetch(origin + '/api/backups/test-alert', {
    method: 'POST', headers: { Cookie: cookie, Origin: requestOrigin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, to: 'attacker@example.test', text: 'arbitrary text' }) });
  try {
    const admin = await login('admin@example.test'), employee = await login('employee@example.test'), other = await login('other@example.test');
    assert.equal((await request('')).status, 401);
    assert.equal((await request(employee)).status, 403); assert.equal((await request(other)).status, 403);
    assert.equal((await request(admin, 'wrong')).status, 401);
    assert.equal((await request(admin, password, 'https://attacker.example')).status, 403);
    assert.equal(sent.length, 0);
    assert.equal((await request(admin)).status, 200); assert.equal(sent.length, 1);
    assert.equal(sent[0].to, undefined); assert(!sent[0].text.includes('arbitrary text'));
    assert.equal((await request(admin)).status, 503); assert.equal(sent.length, 1);
  } finally { await new Promise(r => server.close(r)); }
});

test('Google upload redirects and incomplete retention listings never delete older copies', async t => {
  const f = await fixture(t), archive = await createArchive(f.db, f.directory, f.key);
  const config = { clientId: 'client', clientSecret: 'secret', refreshToken: 'refresh', folderId: 'folder' };
  let unsafeRequests = 0;
  const unsafeLocation = async url => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'mock-token' });
    if (url.includes('uploadType=resumable')) return new Response(null, { headers: { location: 'https://attacker.example/upload/drive/' } });
    unsafeRequests++; return new Response(null);
  };
  await assert.rejects(googleDriveDestination(config, { fetchImpl: unsafeLocation }).upload(archive, 2), /unexpected upload destination/);
  assert.equal(unsafeRequests, 0);
  let deleted = 0;
  const incompleteListing = async (url, options = {}) => {
    if (url.endsWith('/token')) return Response.json({ access_token: 'mock-token' });
    if (url.includes('uploadType=resumable')) return new Response(null, { headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?upload_id=test' } });
    if (options.method === 'PUT') {
      const hash = createHash('md5'); for await (const chunk of options.body) hash.update(chunk);
      return Response.json({ id: 'new', size: String(archive.bytes), md5Checksum: hash.digest('hex') });
    }
    if (options.method === 'DELETE') { deleted++; return new Response(null, { status: 204 }); }
    if (url.includes('pageToken=next')) return new Response(null, { status: 500 });
    return Response.json({ nextPageToken: 'next', files: [{ id: 'old', name: archive.name.replace(/timekeeper-\d{4}/, 'timekeeper-2019') }] });
  };
  await assert.rejects(googleDriveDestination(config, { fetchImpl: incompleteListing }).upload(archive, 1), /listing failed/);
  assert.equal(deleted, 0);
});

test('Google setup uses state and PKCE and cleans up denied authorization without printing secrets', { timeout: 10000 }, async t => {
  const f = await fixture(t), clientPath = join(f.root, 'desktop-client.json'), outputPath = join(f.root, 'google-credentials.json');
  await writeFile(clientPath, JSON.stringify({ installed: { client_id: 'test.apps.googleusercontent.com', client_secret: 'test-client-secret' } }));
  const child = spawn(process.execPath, ['scripts/google-backup-setup.js', clientPath, outputPath], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let errors = ''; child.stderr.on('data', data => { errors += data; });
  const [printed] = await once(child.stdout, 'data');
  const authorize = new URL(printed.toString().match(/https:\/\/accounts\.google\.com\/\S+/)[0]);
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert(authorize.searchParams.get('state').length >= 32); assert(!printed.toString().includes('test-client-secret'));
  const callback = new URL(authorize.searchParams.get('redirect_uri'));
  callback.search = new URLSearchParams({ state: 'wrong-state', code: 'fake-code' });
  assert.equal((await fetch(callback)).status, 400);
  const exited = once(child, 'exit');
  callback.search = new URLSearchParams({ state: authorize.searchParams.get('state'), error: 'access_denied' });
  assert.equal((await fetch(callback)).status, 400);
  const [code] = await exited; assert.equal(code, 1);
  await assert.rejects(stat(outputPath), { code: 'ENOENT' });
  assert(!errors.includes('test-client-secret'));
});

test('production entrypoint enables scheduled backups from secure configuration', { timeout: 20000 }, async t => {
  const f = await fixture(t), keyFile = join(f.root, 'private.backup.key');
  await writeFile(keyFile, f.key.toString('base64'), { mode: 0o600 });
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(r => probe.close(r));
  const publicOrigin = 'https://backup-test.onrender.com';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => !/^(BACKUP_|GOOGLE_BACKUP_|R2_BACKUP_|RESEND_|EMAIL_|AUTH_EMAIL_)/.test(name)
        )
      ), NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(port), DATA_DIR: f.dataDir, APP_ORIGIN: '', RENDER_EXTERNAL_URL: publicOrigin,
      BACKUP_ENABLED: 'true', BACKUP_KEY_FILE: keyFile, BACKUP_ENCRYPTION_KEY: '', BACKUP_DIR: f.directory, BACKUP_OPERATOR_EMAILS: 'admin@example.test',
      BACKUP_INTERVAL_HOURS: '24', BACKUP_RETAIN: '2', GOOGLE_BACKUP_CREDENTIALS_FILE: '', GOOGLE_BACKUP_CLIENT_ID: '', GOOGLE_BACKUP_CLIENT_SECRET: '', GOOGLE_BACKUP_REFRESH_TOKEN: '', GOOGLE_BACKUP_FOLDER_ID: ''
    }
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGTERM'); });
  let errorText = ''; child.stderr.on('data', data => { errorText += data; });
  await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('Backup server failed to start: ' + errorText); })]);
  const base = `http://127.0.0.1:${port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: publicOrigin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@example.test', password }) });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /Secure/);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  let status;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    status = await (await fetch(base + '/api/backups/status', { headers: { Cookie: cookie } })).json();
    if (status.lastSuccessAt) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(status.enabled, true); assert.equal(status.canDownload, true); assert(status.lastLocalAt, JSON.stringify(status) + errorText); assert.equal(status.offsiteConfigured, false);
  const [name] = await listArchives(f.directory); await verifyArchive(join(f.directory, name), f.key);
  const exited = once(child, 'exit'); child.kill('SIGTERM'); const [code] = await exited; assert.equal(code, 0);
});
