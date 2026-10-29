import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.js';

const password = 'audit integration password';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'timekeeper-audit-'));
  let server, origin;
  const start = async () => {
    server = createApp({ dataDir: directory, secureCookies: false, allowedOrigin: null, allowPublicRegistration: true, authAttemptLimit: 200, ...options });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); origin = `http://127.0.0.1:${server.address().port}`;
  };
  await start();
  t.after(async () => { await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, cookie, data, method = data ? 'POST' : 'GET') => {
    const response = await fetch(origin + path, { method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = await request('/api/auth/register', null, { name: 'Actual admin', email: 'admin@example.test', password });
  const outsider = await request('/api/auth/register', null, { name: 'Other admin', email: 'other@example.test', password });
  const save = doc => request('/api/workspace', owner.cookie, { data: doc.data, revision: doc.revision, actorName: 'Forged actor', summary: 'Forged event' }, 'PUT');
  const doc = (await request('/api/workspace', owner.cookie)).body;
  doc.data.contracts.push({ id: 'contract', name: 'Work', client: 'Client', email: '', address: '', rate: 10000, budget: 100, active: true });
  doc.data.employees.push({ id: 'worker', name: 'Worker', email: 'worker@example.test', active: true, contracts: ['contract'] });
  assert.equal((await save(doc)).status, 200);
  const invitation = await request('/api/invitations', owner.cookie, { email: 'worker@example.test', role: 'employee', employeeId: 'worker' });
  const worker = await request('/api/auth/register', null, { name: 'Actual employee', email: 'worker@example.test', password, inviteToken: invitation.body.token });
  return { directory, request, owner, worker, outsider, invitation, save,
    history: async () => (await request('/api/activity', owner.cookie)).body,
    restart: async () => { await new Promise(r => server.close(r)); await start(); } };
}
test('audit is admin-only, workspace-bound, immutable, and records real invitation actors', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/activity')).status, 401);
  assert.equal((await f.request('/api/activity', f.worker.cookie)).status, 403);
  assert.deepEqual((await f.request('/api/activity?workspaceId=forged', f.outsider.cookie)).body.events, []);
  assert.equal((await f.request('/api/activity', f.owner.cookie, { actorName: 'fake' })).status, 404);
  const events = (await f.history()).events;
  assert(events.some(e => e.type === 'invitation.created' && e.actorName === 'Actual admin'));
  assert(events.some(e => e.type === 'invitation.accepted' && e.actorName === 'Actual employee' && e.actorRole === 'employee'));
  assert(!JSON.stringify(events).includes(f.invitation.body.token)); assert(!JSON.stringify(events).includes(password));
  assert(!JSON.stringify(events).includes('Forged actor'));
  const db = new DatabaseSync(join(f.directory, 'timekeeper.sqlite'));
  try {
    assert.throws(() => db.exec("UPDATE audit_events SET summary='tampered'"), /cannot be updated/);
    assert.throws(() => db.exec('DELETE FROM audit_events'), /cannot be deleted/);
    db.prepare("UPDATE users SET name='New employee name' WHERE email='worker@example.test'").run();
  } finally { db.close(); }
  await f.restart();
  assert((await f.history()).events.some(e => e.actorName === 'Actual employee'));
});
test('submission, withdrawal, approval, invoices and payments are recorded after validated writes', async t => {
  const f = await fixture(t);
  const employeeWrite = async status => {
    const doc = (await f.request('/api/workspace', f.worker.cookie)).body;
    doc.data.sheets = [{ id: 'sheet', employeeId: 'worker', start: '2026-10-16', status, rows: [{ id: 'row', contractId: 'contract', status, hours: { '2026-10-16': 2 }, note: '' }] }];
    return f.request('/api/employee/timesheets', f.worker.cookie, { sheets: doc.data.sheets, revision: doc.revision }, 'PUT');
  };
  assert.equal((await employeeWrite('submitted')).status, 200);
  assert.equal((await employeeWrite('draft')).status, 200);
  assert.equal((await employeeWrite('submitted')).status, 200);
  const doc = (await f.request('/api/workspace', f.owner.cookie)).body;
  doc.data.sheets[0].rows[0].status = 'approved'; doc.data.sheets[0].status = 'approved';
  assert.equal((await f.save(doc)).status, 200);
  const invoiceDoc = (await f.request('/api/workspace', f.owner.cookie)).body;
  invoiceDoc.data.invoices.push({ id: 'invoice', number: 'INV-1001', contractId: 'contract', client: 'Client', contract: 'Work', email: '', address: '', business: { ...invoiceDoc.data.settings }, issued: '2026-10-20', due: '2026-10-31', sentDate: '2026-10-20', lines: [{ description: 'Work', sources: [{ sheetId: 'sheet', rowId: 'row' }], employee: 'Worker', start: '2026-10-16', end: '2026-10-31', hours: 2, rate: 10000, amount: 20000 }], payments: [], note: 'private invoice note' });
  assert.equal((await f.save(invoiceDoc)).status, 200);
  const paymentDoc = (await f.request('/api/workspace', f.owner.cookie)).body;
  paymentDoc.data.invoices[0].payments.push({ id: 'payment', date: '2026-10-21', amount: 20000, reference: 'private payment reference' });
  assert.equal((await f.save(paymentDoc)).status, 200);
  const events = (await f.history()).events;
  for (const type of ['timesheet.submitted', 'timesheet.withdrawn', 'timesheet.approved', 'invoice.created', 'payment.recorded']) assert(events.some(e => e.type === type), type);
  assert.equal(events.find(e => e.type === 'timesheet.submitted').actorRole, 'employee');
  assert.equal(events.find(e => e.type === 'timesheet.approved').actorName, 'Actual admin');
  assert.equal(events.find(e => e.type === 'payment.recorded').details.amount, 20000);
  assert(!JSON.stringify(events).includes('private invoice note')); assert(!JSON.stringify(events).includes('private payment reference'));
  const count = events.length;
  assert.equal((await f.save(paymentDoc)).status, 409); // stale revision
  assert.equal((await f.history()).events.length, count);
  const fresh = (await f.request('/api/workspace', f.owner.cookie)).body;
  assert.equal((await f.save(fresh)).status, 200); // no-op produces no misleading event
  assert.equal((await f.history()).events.length, count);
});
test('audit failure rolls back business changes; role changes and removals are recorded atomically', async t => {
  const f = await fixture(t), before = (await f.request('/api/workspace', f.owner.cookie)).body;
  const count = (await f.history()).events.length;
  const db = new DatabaseSync(join(f.directory, 'timekeeper.sqlite'));
  db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'test audit storage unavailable'); END;");
  const changed = structuredClone(before); changed.data.settings.business = 'Must roll back';
  assert.equal((await f.save(changed)).status, 500);
  db.exec('DROP TRIGGER reject_audit'); db.close();
  const after = (await f.request('/api/workspace', f.owner.cookie)).body;
  assert.deepEqual(after, before); assert.equal((await f.history()).events.length, count);
  const workerId = f.worker.body.user.id;
  assert.equal((await f.request(`/api/members/${workerId}`, f.owner.cookie, { role: 'admin' }, 'PATCH')).status, 200);
  assert.equal((await f.request(`/api/members/${workerId}`, f.owner.cookie, null, 'DELETE')).status, 200);
  assert((await f.history()).events.some(e => e.type === 'member.role_changed' && e.details.to === 'admin'));
  assert((await f.history()).events.some(e => e.type === 'member.removed'));
  assert.equal((await f.request('/api/activity', f.worker.cookie)).status, 401);
});
test('history pagination has no duplicates or cross-workspace entries', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 53; i++) {
    const doc = (await f.request('/api/workspace', f.owner.cookie)).body;
    doc.data.settings.business = `Revision ${i}`; assert.equal((await f.save(doc)).status, 200);
  }
  const first = await f.history(); assert.equal(first.events.length, 50); assert(first.nextCursor);
  const second = (await f.request('/api/activity?before=' + first.nextCursor, f.owner.cookie)).body;
  assert(second.events.length > 0); assert(second.events.every(e => e.id < first.nextCursor));
  assert.equal(new Set([...first.events, ...second.events].map(e => e.id)).size, first.events.length + second.events.length);
  assert.equal((await f.request('/api/activity?before=-1', f.owner.cookie)).status, 400);
  assert.equal((await f.request('/api/activity?before=nan', f.owner.cookie)).status, 400);
  assert.deepEqual((await f.request('/api/activity?before=' + first.nextCursor, f.outsider.cookie)).body.events, []);
});

test('committed transitions send emails once; queue errors roll back changes and history', async t => {
  const sent = [], f = await fixture(t, { timesheetEmailConfig: { origin: 'https://timekeeper.example.test', send: async email => sent.push(email) } });
  const submit = async () => {
    const doc = (await f.request('/api/workspace', f.worker.cookie)).body;
    doc.data.sheets = [{ id: 'sheet', employeeId: 'worker', start: '2026-10-16', status: 'submitted', rows: [{ id: 'row', contractId: 'contract', status: 'submitted', hours: { '2026-10-16': 2 }, note: 'private time note' }] }];
    return f.request('/api/employee/timesheets', f.worker.cookie, { sheets: doc.data.sheets, revision: doc.revision }, 'PUT');
  };
  const db = new DatabaseSync(join(f.directory, 'timekeeper.sqlite'));
  db.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON timesheet_notifications BEGIN SELECT RAISE(ABORT,'test queue unavailable'); END;");
  assert.equal((await submit()).status, 500);
  assert.equal((await f.request('/api/workspace', f.worker.cookie)).body.data.sheets.length, 0);
  assert(!(await f.history()).events.some(e => e.type === 'timesheet.submitted')); assert.equal(sent.length, 0);
  db.exec('DROP TRIGGER reject_notice'); db.close();
  assert.equal((await submit()).status, 200); await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1); assert.equal(sent[0].to, 'admin@example.test');
  assert.equal((await submit()).status, 200); assert.equal(sent.length, 1);
  const doc = (await f.request('/api/workspace', f.owner.cookie)).body;
  doc.data.sheets[0].rows[0].status = 'approved'; doc.data.sheets[0].status = 'approved';
  assert.equal((await f.save(doc)).status, 200); await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 2); assert.equal(sent[1].to, 'worker@example.test');
  assert(!JSON.stringify(sent).includes('private time note')); assert(!JSON.stringify(sent).includes('10000'));
  assert.equal((await f.request('/api/timesheet-notifications/status', f.worker.cookie)).status, 403);
  assert.equal((await f.request('/api/timesheet-notifications/retry', f.worker.cookie, {})).status, 403);
  assert.equal((await f.request('/api/timesheet-notifications/retry', f.outsider.cookie, {})).body.queued, 0);
  assert.equal((await f.request('/api/timesheet-notifications/status', f.outsider.cookie)).body.accepted, 0);
  assert.equal((await f.request('/api/timesheet-notifications/status', f.owner.cookie)).body.accepted, 2);
  await f.restart(); assert.equal(sent.length, 2);
});
