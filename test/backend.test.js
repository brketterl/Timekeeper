import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp, deploymentOptions } from '../server/index.js';
import { createHash } from 'node:crypto';
import { openDatabase } from '../server/db.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'timekeeper-test-'));
  let server;
  async function start() {
    // Test HTTP servers must not inherit the hosting process's cookies or origin.
    // Explicit production-cookie tests override these defaults below.
    server = createApp({ allowPublicRegistration: true, dataDir: directory, secureCookies: false, allowedOrigin: null, ...options });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }
  let origin = await start();
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return {
    directory,
    async restart() { await new Promise(resolve => server.close(resolve)); origin = await start(); },
    async request(path, { method = 'GET', cookie, data, requestOrigin = origin } = {}) {
      const response = await fetch(origin + path, { method, headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(method !== 'GET' ? { Origin: requestOrigin, 'Content-Type': 'application/json' } : {})
      }, ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });
      const result = await response.json();
      return { status: response.status, body: result, setCookie: response.headers.get('set-cookie'), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
  };
}
const account = { name: 'Owner', email: 'owner@example.com', password: 'a strong test password' };

async function setupShared(t) {
  const app = await fixture(t);
  const admin = await app.request('/api/auth/register', { method: 'POST', data: account });
  const doc = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  doc.data.contracts = [
    { id: 'assigned', name: 'Assigned work', client: 'Client A', email: 'billing@example.com', address: 'Private address', rate: 12500, budget: 100, active: true },
    { id: 'unassigned', name: 'Other work', client: 'Client B', email: '', address: '', rate: 20000, budget: 100, active: true }
  ];
  doc.data.employees.push({ id: 'worker', name: 'Worker record', email: 'worker@example.com', active: true, contracts: ['assigned'] });
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: admin.cookie, data: { data: doc.data, revision: doc.revision } })).status, 200);
  const invitation = await app.request('/api/invitations', { method: 'POST', cookie: admin.cookie, data: { email: 'worker@example.com', role: 'employee', employeeId: 'worker' } });
  assert.equal(invitation.status, 200);
  const worker = await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'worker@example.com', name: 'Worker account', inviteToken: invitation.body.token } });
  assert.equal(worker.status, 201);
  return { app, admin, worker, invitation };
}

test('accounts, authentication, sessions, and credential storage', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/workspace')).status, 401);
  assert.equal((await app.request('/api/auth/register', { method: 'POST', data: { ...account, password: 'short' } })).status, 400);
  assert.equal((await app.request('/api/auth/register', { method: 'POST', data: null })).status, 400);
  const registration = await app.request('/api/auth/register', { method: 'POST', data: account });
  assert.equal(registration.status, 201);
  assert.match(registration.setCookie, /HttpOnly/); assert.match(registration.setCookie, /SameSite=Lax/);
  assert.equal((await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'OWNER@EXAMPLE.COM' } })).status, 409);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', data: { ...account, password: 'incorrect' } })).status, 401);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', data: { ...account, email: 'missing@example.com' } })).status, 401);
  const login = await app.request('/api/auth/login', { method: 'POST', data: account });
  assert.equal(login.status, 200);
  assert.notEqual(login.cookie, registration.cookie);
  assert.equal((await app.request('/api/auth/me', { cookie: login.cookie })).body.role, 'admin');
  const db = new DatabaseSync(join(app.directory, 'timekeeper.sqlite'));
  const user = db.prepare('SELECT * FROM users').get();
  assert.notEqual(user.password_hash, account.password);
  assert.match(user.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  const tokens = db.prepare('SELECT token_hash FROM sessions').all();
  assert(tokens.every(row => row.token_hash !== login.cookie.split('=')[1]));
  db.prepare('UPDATE sessions SET expires_at = 0').run(); db.close();
  assert.equal((await app.request('/api/auth/me', { cookie: login.cookie })).status, 401);
  const fresh = await app.request('/api/auth/login', { method: 'POST', data: account });
  assert.equal((await app.request('/api/auth/logout', { method: 'POST', cookie: fresh.cookie, data: {} })).status, 200);
  assert.equal((await app.request('/api/auth/me', { cookie: fresh.cookie })).status, 401);
});

test('workspace isolation, validation, concurrency protection, and restart persistence', async t => {
  const app = await fixture(t);
  const first = await app.request('/api/auth/register', { method: 'POST', data: account });
  const second = await app.request('/api/auth/register', { method: 'POST', data: { ...account, name: 'Other', email: 'other@example.com' } });
  const initial = (await app.request('/api/workspace', { cookie: first.cookie })).body;
  assert.equal(initial.data.demo, false); assert.equal(initial.data.employees.length, 1);
  assert.equal(initial.data.employees[0].email, account.email);
  initial.data.settings.business = 'Persisted business';
  const saved = await app.request('/api/workspace', { method: 'PUT', cookie: first.cookie, data: initial });
  assert.equal(saved.status, 200); assert.equal(saved.body.revision, 1);
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: first.cookie, data: initial })).status, 409);
  assert.notEqual((await app.request('/api/workspace', { cookie: second.cookie })).body.data.settings.business, 'Persisted business');
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: first.cookie, data: { revision: 1, data: {} } })).status, 400);
  await app.restart();
  const restored = await app.request('/api/workspace', { cookie: first.cookie });
  assert.equal(restored.status, 200); assert.equal(restored.body.data.settings.business, 'Persisted business');
  assert.equal(restored.body.revision, 1);
});

test('CSRF protection, authorization, and session revocation through membership changes', async t => {
  const app = await fixture(t);
  assert.equal((await app.request('/api/auth/register', { method: 'POST', data: account, requestOrigin: 'https://attacker.example' })).status, 403);
  const owner = await app.request('/api/auth/register', { method: 'POST', data: account });
  const doc = (await app.request('/api/workspace', { cookie: owner.cookie })).body;
  assert.equal((await app.request('/api/workspace', { method: 'PUT', data: doc })).status, 401);
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: owner.cookie, data: doc, requestOrigin: 'https://attacker.example' })).status, 403);
  const db = new DatabaseSync(join(app.directory, 'timekeeper.sqlite'));
  db.prepare("UPDATE memberships SET role = 'employee'").run();
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: owner.cookie, data: doc })).status, 403);
  assert.equal((await app.request('/api/workspace', { cookie: owner.cookie })).status, 200);
  db.prepare('DELETE FROM memberships').run(); db.close();
  assert.equal((await app.request('/api/auth/me', { cookie: owner.cookie })).status, 401);
});

test('authentication attempts are rate limited', async t => {
  const app = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await app.request('/api/auth/login', { method: 'POST', data: {} })).status, 400);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', data: account })).status, 429);
});

test('production sessions require explicit origin and Secure cookies', async t => {
  assert.throws(() => createApp({ secureCookies: true, allowedOrigin: null }), /APP_ORIGIN/);
  assert.throws(() => createApp({ secureCookies: true, allowedOrigin: 'http://timekeeper.example' }), /HTTPS/);
  assert.throws(() => createApp({ allowedOrigin: 'https://timekeeper.example/unexpected-path' }), /without a path/);
  const app = await fixture(t, { secureCookies: true, allowedOrigin: 'https://timekeeper.example' });
  const result = await app.request('/api/auth/register', { method: 'POST', data: account, requestOrigin: 'https://timekeeper.example' });
  assert.equal(result.status, 201); assert.match(result.setCookie, /; Secure/);
});

test('hosting uses the external HTTPS origin, persistent directory, and production interface', () => {
  const options = deploymentOptions({ NODE_ENV: 'production', PORT: '10000', DATA_DIR: '/var/data/timekeeper', RENDER_EXTERNAL_URL: 'https://timekeeper-example.onrender.com' });
  assert.equal(options.host, '0.0.0.0'); assert.equal(options.port, 10000);
  assert.equal(options.dataDir, '/var/data/timekeeper'); assert.equal(options.secureCookies, true);
  assert.equal(options.allowedOrigin, 'https://timekeeper-example.onrender.com');
  assert.equal(deploymentOptions({}).host, '127.0.0.1');
  assert.equal(deploymentOptions({ APP_ORIGIN: 'https://custom.example', RENDER_EXTERNAL_URL: 'https://default.example' }).allowedOrigin, 'https://custom.example');
  for (const PORT of ['not-a-port', '0', '65536']) assert.throws(() => deploymentOptions({ PORT }), /PORT/);
});

test('invitations link employees and employee responses exclude billing and other staff', async t => {
  const { app, admin, worker, invitation } = await setupShared(t);
  const result = await app.request('/api/workspace', { cookie: worker.cookie });
  assert.equal(result.body.role, 'employee'); assert.equal(result.body.employeeId, 'worker');
  assert.equal(result.body.data.employees.length, 1); assert.equal(result.body.data.contracts.length, 1);
  assert.equal(result.body.data.contracts[0].id, 'assigned');
  for (const key of ['rate', 'budget', 'email', 'address']) assert.equal(key in result.body.data.contracts[0], false);
  assert.deepEqual(result.body.data.invoices, []);
  assert.equal('paymentNote' in result.body.data.settings, false);
  assert.equal((await app.request('/api/workspaces', { cookie: worker.cookie })).body.length, 1);
  for (const path of ['/api/members', '/api/invitations', '/api/invoices']) assert.equal((await app.request(path, { cookie: worker.cookie })).status, 403);
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: worker.cookie, data: result.body })).status, 403);
  assert.equal((await app.request('/api/invitations', { method: 'POST', cookie: worker.cookie, data: { email: 'x@example.com', role: 'admin' } })).status, 403);
  assert.equal((await app.request('/api/invitations/accept', { method: 'POST', cookie: worker.cookie, data: { token: invitation.body.token } })).status, 410);
  const db = new DatabaseSync(join(app.directory, 'timekeeper.sqlite'));
  assert.equal(db.prepare('SELECT employee_id FROM memberships WHERE user_id = ?').get(worker.body.user.id).employee_id, 'worker');
  assert.notEqual(db.prepare('SELECT token_hash FROM invitations').get().token_hash, invitation.body.token); db.close();
  assert.equal((await app.request('/api/members', { cookie: admin.cookie })).body.length, 2);
});

test('employees edit own draft hours, submit/withdraw, and cannot forge approval or change locked rows', async t => {
  const { app, admin, worker } = await setupShared(t);
  let doc = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  const sheet = { id: 'sheet1', employeeId: 'worker', start: '2026-10-01', status: 'draft', rows: [{ id: 'row1', contractId: 'assigned', status: 'draft', hours: { '2026-10-01': 8 }, note: 'Work completed' }] };
  const save = (sheets, revision = doc.revision) => app.request('/api/employee/timesheets', { method: 'PUT', cookie: worker.cookie, data: { sheets, revision } });
  assert.equal((await save([{ ...sheet, employeeId: admin.body.user.id }])).status, 403);
  assert.equal((await save([{ ...sheet, rows: [{ ...sheet.rows[0], contractId: 'unassigned' }] }])).status, 403);
  assert.equal((await save([{ ...sheet, rows: [{ ...sheet.rows[0], rate: 1 }] }])).status, 400);
  assert.equal((await save([{ ...sheet, status: 'approved', rows: [{ ...sheet.rows[0], status: 'approved' }] }])).status, 403);
  assert.equal((await save([{ ...sheet, rows: [{ ...sheet.rows[0], hours: { '2026-10-01': 25 } }] }])).status, 400);
  assert.equal((await save([sheet])).status, 200);
  assert.equal((await save([sheet])).status, 409);
  doc = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  sheet.status = sheet.rows[0].status = 'submitted';
  assert.equal((await save([sheet])).status, 200);
  doc = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  assert.equal('rate' in doc.data.sheets[0].rows[0], false);
  assert.equal((await save([{ ...sheet, rows: [{ ...sheet.rows[0], note: 'Changed after submitting' }] }])).status, 403);
  assert.equal((await save([])).status, 403);
  sheet.status = sheet.rows[0].status = 'draft';
  assert.equal((await save([sheet])).status, 200);
  doc = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  sheet.status = sheet.rows[0].status = 'submitted'; assert.equal((await save([sheet])).status, 200);
  const full = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  assert.equal(full.data.sheets[0].rows[0].rate, 12500);
  full.data.sheets[0].status = full.data.sheets[0].rows[0].status = 'approved';
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: admin.cookie, data: { data: full.data, revision: full.revision } })).status, 200);
  doc = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  const locked = doc.data.sheets[0];
  assert.equal((await save([{ ...locked, rows: [{ ...locked.rows[0], hours: { '2026-10-01': 1 } }] }])).status, 403);
  assert.equal((await save([{ ...locked, status: 'draft', rows: [] }])).status, 403);
  assert.equal((await save([locked])).status, 200);
});

test('shared admins, role changes, removal, and last-admin protection', async t => {
  const { app, admin, worker } = await setupShared(t);
  assert.equal((await app.request(`/api/members/${admin.body.user.id}`, { method: 'PATCH', cookie: admin.cookie, data: { role: 'employee' } })).status, 409);
  assert.equal((await app.request(`/api/members/${admin.body.user.id}`, { method: 'DELETE', cookie: admin.cookie })).status, 409);
  assert.equal((await app.request(`/api/members/${admin.body.user.id}`, { method: 'PATCH', cookie: worker.cookie, data: { role: 'admin' } })).status, 403);
  assert.equal((await app.request(`/api/members/${worker.body.user.id}`, { method: 'PATCH', cookie: admin.cookie, data: { role: 'admin' } })).status, 200);
  assert.equal((await app.request('/api/workspace', { cookie: worker.cookie })).body.data.contracts.length, 2);
  const full = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  full.data.settings.business = 'Shared by partners';
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: worker.cookie, data: { data: full.data, revision: full.revision } })).status, 200);
  assert.equal((await app.request('/api/workspace', { cookie: admin.cookie })).body.data.settings.business, 'Shared by partners');
  assert.equal((await app.request(`/api/members/${admin.body.user.id}`, { method: 'PATCH', cookie: worker.cookie, data: { role: 'employee' } })).status, 200);
  assert.equal((await app.request('/api/members', { cookie: admin.cookie })).status, 403);
  assert.equal((await app.request(`/api/members/${worker.body.user.id}`, { method: 'DELETE', cookie: worker.cookie })).status, 409);
  assert.equal((await app.request(`/api/members/${admin.body.user.id}`, { method: 'DELETE', cookie: worker.cookie })).status, 200);
  assert.equal((await app.request('/api/workspace', { cookie: admin.cookie })).status, 401);
  assert.equal((await app.request('/api/workspace', { cookie: worker.cookie })).status, 200);
});

test('existing accounts accept invitations, switch workspaces, and cannot cross workspace boundaries', async t => {
  const { app, admin, worker } = await setupShared(t);
  const outsider = await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'outside@example.com' } });
  const oldWorkspace = (await app.request('/api/workspace', { cookie: outsider.cookie })).body.workspaceId;
  const sharedWorkspace = (await app.request('/api/workspace', { cookie: admin.cookie })).body.workspaceId;
  assert.equal((await app.request('/api/auth/switch', { method: 'POST', cookie: outsider.cookie, data: { workspaceId: sharedWorkspace } })).status, 403);
  const invitation = await app.request('/api/invitations', { method: 'POST', cookie: admin.cookie, data: { email: 'outside@example.com', role: 'admin' } });
  assert.equal((await app.request(`/api/invitations/${invitation.body.id}`, { method: 'DELETE', cookie: outsider.cookie })).status, 404);
  assert.equal((await app.request('/api/invitations/accept', { method: 'POST', cookie: worker.cookie, data: { token: invitation.body.token } })).status, 403);
  const accepted = await app.request('/api/invitations/accept', { method: 'POST', cookie: outsider.cookie, data: { token: invitation.body.token } });
  assert.equal(accepted.status, 200);
  assert.equal((await app.request('/api/workspace', { cookie: accepted.cookie })).body.workspaceId, sharedWorkspace);
  assert.equal((await app.request('/api/workspaces', { cookie: accepted.cookie })).body.length, 2);
  assert.equal((await app.request('/api/workspace', { cookie: outsider.cookie })).status, 401);
  const switched = await app.request('/api/auth/switch', { method: 'POST', cookie: accepted.cookie, data: { workspaceId: oldWorkspace } });
  assert.equal(switched.status, 200);
  assert.equal((await app.request('/api/workspace', { cookie: switched.cookie })).body.workspaceId, oldWorkspace);
});

test('invitation expiry, revocation, replacement, email binding, and linked-record protection', async t => {
  const app = await fixture(t);
  const admin = await app.request('/api/auth/register', { method: 'POST', data: account });
  const invite = () => app.request('/api/invitations', { method: 'POST', cookie: admin.cookie, data: { email: 'join@example.com', role: 'employee' } });
  const first = await invite();
  assert.equal((await app.request('/api/invitations/preview', { method: 'POST', data: { token: first.body.token } })).status, 200);
  const second = await invite();
  assert.equal((await app.request('/api/invitations/preview', { method: 'POST', data: { token: first.body.token } })).status, 410);
  const wrong = await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'wrong@example.com', inviteToken: second.body.token } });
  assert.equal(wrong.status, 403);
  const db = new DatabaseSync(join(app.directory, 'timekeeper.sqlite'));
  assert.equal(db.prepare('SELECT 1 FROM users WHERE email = ?').get('wrong@example.com'), undefined);
  db.prepare('UPDATE invitations SET expires_at = 0 WHERE id = ?').run(second.body.id); db.close();
  assert.equal((await app.request('/api/invitations/preview', { method: 'POST', data: { token: second.body.token } })).status, 410);
  const third = await invite();
  assert.equal((await app.request(`/api/invitations/${third.body.id}`, { method: 'DELETE', cookie: admin.cookie })).status, 200);
  assert.equal((await app.request('/api/invitations/preview', { method: 'POST', data: { token: third.body.token } })).status, 410);
  const doc = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  doc.data.employees[0].email = 'changed@example.com';
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: admin.cookie, data: { data: doc.data, revision: doc.revision } })).status, 409);
});

test('removed members can rejoin through an invitation when signing in', async t => {
  const { app, admin, worker } = await setupShared(t);
  assert.equal((await app.request(`/api/members/${worker.body.user.id}`, { method: 'DELETE', cookie: admin.cookie })).status, 200);
  const invite = await app.request('/api/invitations', { method: 'POST', cookie: admin.cookie, data: { email: 'worker@example.com', role: 'employee', employeeId: 'worker' } });
  const login = await app.request('/api/auth/login', { method: 'POST', data: { email: 'worker@example.com', password: account.password, inviteToken: invite.body.token } });
  assert.equal(login.status, 200);
  assert.equal((await app.request('/api/workspace', { cookie: login.cookie })).body.employeeId, 'worker');
});

test('schema migration upgrades existing owners without losing workspace data or sessions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'timekeeper-migration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = new DatabaseSync(join(directory, 'timekeeper.sqlite'));
  old.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); INSERT INTO schema_migrations VALUES(1);
    CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, created_at INTEGER);
    CREATE TABLE workspaces(id TEXT PRIMARY KEY, name TEXT, created_at INTEGER);
    CREATE TABLE memberships(user_id TEXT, workspace_id TEXT, role TEXT CHECK(role IN ('owner','employee')), PRIMARY KEY(user_id,workspace_id));
    CREATE TABLE workspace_documents(workspace_id TEXT PRIMARY KEY, data TEXT, revision INTEGER, updated_at INTEGER);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT, workspace_id TEXT, expires_at INTEGER);`);
  old.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run('original-user', account.email, 'Original owner', 'unused', 0);
  old.prepare('INSERT INTO workspaces VALUES(?,?,?)').run('original-workspace', 'Existing business', 0);
  old.prepare('INSERT INTO memberships VALUES(?,?,?)').run('original-user', 'original-workspace', 'owner');
  const data = { version: 2, demo: false, settings: { business: 'Existing business', email: '', address: '', paymentNote: '', schedule: 'semimonthly' }, employees: [{ id: 'legacy-employee', name: 'You', email: '', contracts: [], active: true }], contracts: [], sheets: [], invoices: [] };
  old.prepare('INSERT INTO workspace_documents VALUES(?,?,?,?)').run('original-workspace', JSON.stringify(data), 7, 0);
  const hash = createHash('sha256').update('existing-session').digest('hex');
  old.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run(hash, 'original-user', 'original-workspace', Date.now() + 10000); old.close();
  const upgraded = openDatabase(directory);
  try {
    const member = upgraded.prepare('SELECT * FROM memberships').get();
    assert.equal(member.role, 'admin'); assert.equal(member.employee_id, 'legacy-employee');
    const doc = upgraded.prepare('SELECT * FROM workspace_documents').get();
    const migrated = JSON.parse(doc.data);
    assert.equal(migrated.settings.business, 'Existing business');
    assert.equal(migrated.employees[0].email, account.email);
    assert.equal(doc.revision, 8);
    assert.equal(upgraded.prepare('SELECT token_hash FROM sessions').get().token_hash, hash);
    assert.equal(upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 4);
  } finally { upgraded.close(); }
  const repeated = openDatabase(directory);
  assert.equal(repeated.prepare('SELECT revision FROM workspace_documents').get().revision, 8); repeated.close();
});

test('account email correction requires a password, preserves identity, and rotates sessions', async t => {
  const { app, admin, worker } = await setupShared(t);
  const oldDoc = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  const secondSession = await app.request('/api/auth/login', { method: 'POST', data: account });
  const change = data => app.request('/api/auth/email', { method: 'PATCH', cookie: admin.cookie, data });
  assert.equal((await app.request('/api/auth/email', { method: 'PATCH', data: { email: 'new@example.com', currentPassword: account.password } })).status, 401);
  assert.equal((await change({ email: 'new@example.com', currentPassword: 'wrong' })).status, 401);
  assert.equal((await change({ email: 'invalid-email', currentPassword: account.password })).status, 400);
  assert.equal((await change({ email: 'worker@example.com', currentPassword: account.password })).status, 409);
  const changed = await change({ email: ' NEW@example.com ', currentPassword: account.password });
  assert.equal(changed.status, 200); assert.equal(changed.body.email, 'new@example.com');
  assert.notEqual(changed.cookie, admin.cookie);
  assert.equal((await app.request('/api/auth/me', { cookie: admin.cookie })).status, 401);
  assert.equal((await app.request('/api/auth/me', { cookie: secondSession.cookie })).status, 401);
  assert.equal((await app.request('/api/auth/me', { cookie: worker.cookie })).status, 200);
  const me = (await app.request('/api/auth/me', { cookie: changed.cookie })).body;
  assert.equal(me.user.id, admin.body.user.id); assert.equal(me.user.email, 'new@example.com'); assert.equal(me.role, 'admin');
  const doc = (await app.request('/api/workspace', { cookie: changed.cookie })).body;
  assert.equal(doc.employeeId, oldDoc.employeeId); assert.equal(doc.revision, oldDoc.revision + 1);
  assert.equal(doc.data.employees.find(e => e.id === doc.employeeId).email, 'new@example.com');
  assert.deepEqual(doc.data.settings, oldDoc.data.settings);
  assert.deepEqual(doc.data.contracts, oldDoc.data.contracts);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', data: account })).status, 401);
  assert.equal((await app.request('/api/auth/login', { method: 'POST', data: { ...account, email: 'new@example.com' } })).status, 200);
});

test('email correction updates all workspace links without allowing changes to other accounts', async t => {
  const { app, admin, worker } = await setupShared(t);
  const invitation = await app.request('/api/invitations', { method: 'POST', cookie: admin.cookie, data: { email: 'other@example.com', role: 'admin' } });
  const other = await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'other@example.com' } });
  const joined = await app.request('/api/invitations/accept', { method: 'POST', cookie: other.cookie, data: { token: invitation.body.token } });
  const changed = await app.request('/api/auth/email', { method: 'PATCH', cookie: joined.cookie, data: { email: 'corrected@example.com', currentPassword: account.password, userId: admin.body.user.id } });
  assert.equal(changed.status, 200);
  const list = (await app.request('/api/workspaces', { cookie: changed.cookie })).body;
  assert.equal(list.length, 2);
  const db = new DatabaseSync(join(app.directory, 'timekeeper.sqlite'));
  const links = db.prepare(`SELECT d.data, m.employee_id FROM memberships m JOIN workspace_documents d ON d.workspace_id=m.workspace_id WHERE m.user_id=?`).all(other.body.user.id);
  for (const link of links) assert.equal(JSON.parse(link.data).employees.find(e => e.id === link.employee_id).email, 'corrected@example.com');
  assert.equal(db.prepare('SELECT email FROM users WHERE id=?').get(admin.body.user.id).email, account.email); db.close();
  const employeeChange = await app.request('/api/auth/email', { method: 'PATCH', cookie: worker.cookie, data: { email: 'worker-fixed@example.com', currentPassword: account.password } });
  assert.equal(employeeChange.status, 200);
  assert.equal((await app.request('/api/workspace', { cookie: employeeChange.cookie })).body.role, 'employee');
  assert.equal((await app.request('/api/members', { cookie: employeeChange.cookie })).status, 403);
});

test('admins delete unused employee records and revoke invites; linked accounts and other workspaces are protected', async t => {
  const { app, admin, worker, invitation } = await setupShared(t);
  const doc = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  doc.data.employees.push({ id: 'unwanted', name: 'Unused record', email: 'unwanted@example.com', active: true, contracts: [] });
  await app.request('/api/workspace', { method: 'PUT', cookie: admin.cookie, data: { data: doc.data, revision: doc.revision } });
  const pending = await app.request('/api/invitations', { method: 'POST', cookie: admin.cookie, data: { email: 'unwanted@example.com', role: 'employee', employeeId: 'unwanted' } });
  const current = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  const remove = (id, cookie = admin.cookie, revision = current.revision) => app.request(`/api/employees/${id}/remove`, { method: 'POST', cookie, data: { revision } });
  assert.equal((await remove('unwanted', worker.cookie)).status, 403);
  assert.equal((await remove('missing')).status, 404);
  assert.equal((await remove('unwanted', admin.cookie, doc.revision)).status, 409);
  assert.equal((await remove(current.employeeId)).status, 409);
  assert.equal((await remove('worker')).status, 409);
  const removed = await remove('unwanted');
  assert.equal(removed.status, 200); assert.equal(removed.body.action, 'deleted');
  const updated = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  assert.equal(updated.data.employees.some(e => e.id === 'unwanted'), false);
  assert.equal((await app.request('/api/invitations/preview', { method: 'POST', data: { token: pending.body.token } })).status, 410);
  assert.equal((await app.request('/api/invitations/preview', { method: 'POST', data: { token: invitation.body.token } })).status, 410);
  const outsider = await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'outside@example.com' } });
  const outsideDoc = (await app.request('/api/workspace', { cookie: outsider.cookie })).body;
  assert.equal((await remove('worker', outsider.cookie, outsideDoc.revision)).status, 404);
});

test('former first admin with invoice history can be archived without losing financial records', async t => {
  const { app, admin, worker } = await setupShared(t);
  const doc = (await app.request('/api/workspace', { cookie: admin.cookie })).body;
  const formerId = doc.employeeId;
  const sheet = { id: 'historical-sheet', employeeId: formerId, start: '2026-10-01', status: 'approved', rows: [{ id: 'historical-row', contractId: 'assigned', rate: 12500, status: 'approved', note: 'Historical work', hours: { '2026-10-01': 8 } }] };
  const invoice = { id: 'historical-invoice', number: 'INV-1001', contractId: 'assigned', client: 'Client A', contract: 'Assigned work', email: 'billing@example.com', address: '', business: { ...doc.data.settings }, issued: '2026-10-02', due: '2026-10-31', sentDate: null, lines: [{ sources: [{ sheetId: sheet.id, rowId: sheet.rows[0].id }], description: 'Historical work', employee: 'Owner', start: sheet.start, end: '2026-10-15', hours: 8, rate: 12500, amount: 100000 }], payments: [], note: '' };
  doc.data.sheets.push(sheet); doc.data.invoices.push(invoice);
  assert.equal((await app.request('/api/workspace', { method: 'PUT', cookie: admin.cookie, data: { data: doc.data, revision: doc.revision } })).status, 200);
  await app.request(`/api/members/${worker.body.user.id}`, { method: 'PATCH', cookie: admin.cookie, data: { role: 'admin' } });
  assert.equal((await app.request(`/api/members/${admin.body.user.id}`, { method: 'DELETE', cookie: worker.cookie })).status, 200);
  const current = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  const archived = await app.request(`/api/employees/${formerId}/remove`, { method: 'POST', cookie: worker.cookie, data: { revision: current.revision } });
  assert.equal(archived.status, 200); assert.equal(archived.body.action, 'archived');
  const result = (await app.request('/api/workspace', { cookie: worker.cookie })).body;
  assert.equal(result.data.employees[0].id, formerId); assert.equal(result.data.employees[0].active, false);
  assert.deepEqual(result.data.sheets, [sheet]); assert.deepEqual(result.data.invoices, [invoice]);
  assert.equal((await app.request('/api/auth/me', { cookie: admin.cookie })).status, 401);
});

test('invitation-only registration blocks direct signup, including an empty installation', async t => {
  const app = await fixture(t, { allowPublicRegistration: false });
  assert.equal((await app.request('/api/auth/features')).body.publicRegistration, false);
  for (const inviteToken of [undefined, '', 'made-up-token', '0'.repeat(64)]) {
    const result = await app.request('/api/auth/register', { method: 'POST', data: { ...account, inviteToken, role: 'admin', allowPublicRegistration: true } });
    assert([403, 404, 410].includes(result.status));
  }
  const db = new DatabaseSync(join(app.directory, 'timekeeper.sqlite'));
  try {
    for (const table of ['users', 'workspaces', 'memberships', 'sessions']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
  } finally { db.close(); }
  assert.equal(deploymentOptions({}).allowPublicRegistration, false);
  assert.equal(deploymentOptions({ NODE_ENV: 'production' }).allowPublicRegistration, false);
  assert.equal(deploymentOptions({ ALLOW_PUBLIC_REGISTRATION: 'false' }).allowPublicRegistration, false);
  assert.equal(deploymentOptions({ ALLOW_PUBLIC_REGISTRATION: 'true' }).allowPublicRegistration, true);
  assert.throws(() => deploymentOptions({ ALLOW_PUBLIC_REGISTRATION: 'yes' }), /ALLOW_PUBLIC_REGISTRATION/);
});

test('closed registration permits only valid invitations and preserves assigned roles', async t => {
  const config = { allowPublicRegistration: true }, app = await fixture(t, config);
  const admin = await app.request('/api/auth/register', { method: 'POST', data: account });
  config.allowPublicRegistration = false; await app.restart();
  assert.equal((await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'intruder@example.com' } })).status, 403);
  for (const role of ['employee', 'admin']) {
    const email = `${role}@example.com`;
    const invite = await app.request('/api/invitations', { method: 'POST', cookie: admin.cookie, data: { email, role } });
    assert.equal(invite.status, 200);
    assert.equal((await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'wrong@example.com', inviteToken: invite.body.token } })).status, 403);
    const joined = await app.request('/api/auth/register', { method: 'POST', data: { ...account, email, inviteToken: invite.body.token, role: 'admin' } });
    assert.equal(joined.status, 201);
    assert.equal((await app.request('/api/auth/me', { cookie: joined.cookie })).body.role, role);
    assert.equal((await app.request('/api/auth/register', { method: 'POST', data: { ...account, email: 'replay@example.com', inviteToken: invite.body.token } })).status, 410);
  }
  const db = new DatabaseSync(join(app.directory, 'timekeeper.sqlite'));
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM workspaces').get().n, 1); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3); }
  finally { db.close(); }
});
