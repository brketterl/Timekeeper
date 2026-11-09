import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../server/db.js';
import { auditStore } from '../server/audit.js';
import { timesheetNotifications } from '../server/timesheet-notifications.js';
import { timesheetEmailOptions } from '../server/email.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'timekeeper-notifications-')), db = openDatabase(directory);
  t.after(async () => { db.close(); await rm(directory, { recursive: true, force: true }); });
  for (const id of ['admin','partner','employee','outsider']) db.prepare('INSERT INTO users VALUES(?,?,?,?,?)').run(id, `${id}@example.test`, id, 'unused-test-hash', Date.now());
  for (const id of ['one','two']) db.prepare('INSERT INTO workspaces VALUES(?,?,?)').run(id, id, Date.now());
  for (const [user, workspace, role] of [['admin','one','admin'],['partner','one','admin'],['employee','one','employee'],['outsider','two','admin']]) db.prepare('INSERT INTO memberships VALUES(?,?,?,?)').run(user,workspace,role,user);
  let time = Date.now(); const sent = [], logs = [];
  const config = { origin: 'https://timekeeper.example.test', send: async email => sent.push(email) };
  const options = { autoStart: false, now: () => time, logger: { error: (...args) => logs.push(args) } };
  const worker = timesheetNotifications(db, config, options), audit = auditStore(db, { onEvent: worker.enqueue });
  const event = (type, actor = 'employee') => audit.record('one', actor, type, 'sheet', 'Changed timesheet', { employeeId: 'employee', period: '2026-10-16', rows: 2 });
  return { db, config, options, sent, logs, worker, audit, event, advance: ms => { time += ms; } };
}
test('submission targets only workspace admins and approval targets the linked account', async t => {
  const f = await fixture(t);
  f.event('timesheet.submitted'); await f.worker.checkDue();
  assert.deepEqual(f.sent.map(e => e.to).sort(), ['admin@example.test','partner@example.test']);
  assert(f.sent.every(e => e.text.includes('https://timekeeper.example.test/')));
  f.event('timesheet.approved', 'admin'); await f.worker.checkDue();
  assert.equal(f.sent.at(-1).to, 'employee@example.test'); assert.match(f.sent.at(-1).subject, /approved/);
  await f.worker.checkDue(); assert.equal(f.sent.length, 3);
  assert.equal(f.worker.status('two').accepted, 0); assert.equal(f.worker.status('one').accepted, 3);
  await f.worker.stop();
  const restarted = timesheetNotifications(f.db, f.config, f.options); await restarted.checkDue(); assert.equal(f.sent.length, 3);
  await restarted.stop();
});
test('recipients are rechecked before delivery, skipping revoked access and changed roles', async t => {
  const f = await fixture(t); f.event('timesheet.submitted');
  f.db.prepare("DELETE FROM memberships WHERE user_id='admin'").run();
  f.db.prepare("UPDATE memberships SET role='employee' WHERE user_id='partner'").run();
  await f.worker.checkDue(); assert.equal(f.sent.length, 0);
  f.event('timesheet.approved', 'employee');
  f.db.prepare("UPDATE memberships SET employee_id='different-record' WHERE user_id='employee'").run();
  await f.worker.checkDue(); assert.equal(f.sent.length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM timesheet_notifications WHERE cancelled_at IS NOT NULL').get().n, 3);
});
test('failed delivery retries with stable identity across restarts, then stops after five attempts', async t => {
  const f = await fixture(t), ids = []; f.config.send = async email => { ids.push(email.id); throw Error('private-provider-secret'); };
  // Only one approval recipient keeps retry counts unambiguous.
  f.event('timesheet.approved', 'admin');
  await f.worker.checkDue(); await f.worker.checkDue(); assert.equal(ids.length, 1);
  await f.worker.stop(); const restarted = timesheetNotifications(f.db, f.config, f.options);
  for (let i = 0; i < 5; i++) { f.advance(15 * 60_000); await restarted.checkDue(); }
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 1);
  assert.equal(restarted.status('one').failed, 1);
  assert(!JSON.stringify(f.logs).includes('private-provider-secret'));
  assert.equal(f.db.prepare('SELECT last_error FROM timesheet_notifications').get().last_error, 'EMAIL_SEND_FAILED');
  f.config.send = async email => f.sent.push(email);
  assert.equal(restarted.retryFailed('two').queued, 0);
  assert.equal(restarted.retryFailed('one').queued, 1);
  await restarted.checkDue(); assert.equal(f.sent.length, 1); assert.equal(f.sent[0].id, ids[0]);
  assert.equal(restarted.status('one').failed, 0);
  await restarted.stop();
});
test('audit rollback removes queued mail and duplicate enqueue cannot add recipients twice', async t => {
  const f = await fixture(t);
  f.db.exec('BEGIN'); f.event('timesheet.submitted'); f.db.exec('ROLLBACK');
  await f.worker.checkDue(); assert.equal(f.sent.length, 0);
  f.event('timesheet.approved', 'admin');
  const eventId = f.db.prepare('SELECT id FROM audit_events').get().id;
  f.worker.enqueue({ id: eventId, workspaceId: 'one', actorId: 'admin', type: 'timesheet.approved', details: { employeeId: 'employee' } });
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM timesheet_notifications').get().n, 1);
});
test('disabled notifications do not queue historical actions; enabling uses only new events', async t => {
  const f = await fixture(t), disabled = timesheetNotifications(f.db, null, f.options);
  const audit = auditStore(f.db, { onEvent: disabled.enqueue });
  audit.record('one','employee','timesheet.submitted','sheet','Submitted',{employeeId:'employee',period:'2026-10-16',rows:1});
  assert.equal(disabled.status('one').enabled, false);
  assert.throws(() => disabled.retryFailed('one'), /disabled/);
  await f.worker.checkDue(); assert.equal(f.sent.length, 0);
  f.event('timesheet.approved','admin'); await f.worker.checkDue(); assert.equal(f.sent.length, 1);
});
test('notification email configuration is independent and validates its enable flag', async () => {
  assert.equal(await timesheetEmailOptions({}), null);
  assert.equal(await timesheetEmailOptions({ TIMESHEET_EMAIL_ENABLED: 'false' }), null);
  await assert.rejects(timesheetEmailOptions({ TIMESHEET_EMAIL_ENABLED: 'yes' }));
  const config = await timesheetEmailOptions({ TIMESHEET_EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_fake', EMAIL_FROM: 'backup@alerts.example.test', AUTH_EMAIL_ENABLED: 'false', BACKUP_ALERTS_ENABLED: 'false' });
  assert.equal(config.from, 'backup@alerts.example.test');
});
