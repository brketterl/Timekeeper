import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupAlerts } from '../server/backup-alerts.js';
import { emailOptions, resendSender } from '../server/email.js';

const hour = 3600_000;
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'timekeeper-alerts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = Date.parse('2026-10-23T00:00:00Z'); const sent = [];
  const options = { directory, now: () => time, send: async email => sent.push(email), logger: { error() {} } };
  return { directory, options, sent, advance: ms => { time += ms; }, snapshot: (error = null, last = time) => ({ error, lastOffsiteAt: last === null ? null : new Date(last).toISOString() }) };
}
test('failure deduplication survives restart, escalates at 48 hours, and sends recovery once', async t => {
  const f = await setup(t), snapshot = f.snapshot('sensitive provider failure');
  let alerts = backupAlerts(f.options); await alerts.check(snapshot);
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].subject, /failed/);
  assert(!f.sent[0].text.includes(snapshot.error));
  await alerts.check(snapshot); assert.equal(f.sent.length, 1);
  alerts = backupAlerts(f.options); await alerts.check(snapshot); assert.equal(f.sent.length, 1);
  f.advance(48 * hour); await alerts.check(snapshot); assert.equal(f.sent.length, 2); assert.match(f.sent[1].subject, /48 hours/);
  await alerts.check(snapshot); assert.equal(f.sent.length, 2);
  await alerts.check(f.snapshot()); assert.equal(f.sent.length, 3); assert.match(f.sent[2].subject, /recovery/);
  alerts = backupAlerts(f.options); await alerts.check(f.snapshot()); assert.equal(f.sent.length, 3);
  await alerts.check(f.snapshot('new failure')); assert.equal(f.sent.length, 4);
  assert.notEqual(f.sent[0].id, f.sent[3].id);
});
test('no first off-site copy triggers overdue after 48 hours even across restarts', async t => {
  const f = await setup(t); let alerts = backupAlerts(f.options);
  await alerts.check(f.snapshot(null, null)); assert.equal(f.sent.length, 0);
  f.advance(47 * hour); alerts = backupAlerts(f.options); await alerts.check(f.snapshot(null, null)); assert.equal(f.sent.length, 0);
  f.advance(hour); await alerts.check(f.snapshot(null, null)); assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].subject, /overdue/);
  await alerts.check(f.snapshot()); assert.match(f.sent[1].subject, /recovery/);
});
test('failed email retries after 15 minutes with same idempotency key and preserves backup status', async t => {
  const f = await setup(t); const ids = []; let fail = true;
  f.options.send = async email => { ids.push(email.id); if (fail) throw Error('private-api-key'); f.sent.push(email); };
  let alerts = backupAlerts(f.options); const snapshot = f.snapshot('failed');
  await alerts.check(snapshot); assert.match(alerts.status().error, /delivery failed/);
  await alerts.check(snapshot); assert.equal(ids.length, 1);
  f.advance(15 * 60_000); alerts = backupAlerts(f.options); fail = false; await alerts.check(snapshot);
  assert.deepEqual(ids, [ids[0], ids[0]]); assert.equal(alerts.status().error, null);
  assert(!JSON.stringify(alerts.status()).includes('private-api-key'));
  assert(!String(await readFile(join(f.directory, 'backup-alert-status.json'))).includes('private-api-key'));
});
test('failed recovery email is retried and concurrent checks coalesce notifications', async t => {
  const f = await setup(t); const alerts = backupAlerts(f.options);
  await Promise.all([alerts.check(f.snapshot('failed')), alerts.check(f.snapshot('failed'))]); assert.equal(f.sent.length, 1);
  let fail = true; f.options.send = null;
  // Sender closure fails only the recovery attempt.
  const options = { ...f.options, send: async email => { if (fail) throw Error('offline'); f.sent.push(email); } };
  const restarted = backupAlerts(options); await restarted.check(f.snapshot()); assert.equal(f.sent.length, 1);
  f.advance(15 * 60_000); fail = false; await restarted.check(f.snapshot());
  assert.equal(f.sent.length, 2); assert.match(f.sent[1].subject, /recovery/);
});
test('test email is serialized and rate limited without changing outage state', async t => {
  const f = await setup(t), alerts = backupAlerts(f.options);
  await alerts.test(); assert.match(f.sent[0].subject, /test/);
  await assert.rejects(alerts.test(), /one minute/);
  await alerts.check(f.snapshot('failed')); assert.match(f.sent[1].subject, /failed/);
  f.advance(60_000); await alerts.test(); assert.equal(f.sent.length, 3);
});
test('Resend configuration validates securely and supports secret files', async t => {
  const f = await setup(t);
  assert.equal(await emailOptions({}), null);
  assert.equal(await emailOptions({ BACKUP_ALERTS_ENABLED: 'false', RESEND_API_KEY: 'bad' }), null);
  const env = { BACKUP_ALERTS_ENABLED: 'true', RESEND_API_KEY: 're_fake_test_key', EMAIL_FROM: 'backup@alerts.example.test', BACKUP_ALERT_TO: 'operator@example.test' };
  assert.deepEqual(await emailOptions(env), { key: env.RESEND_API_KEY, from: env.EMAIL_FROM, to: env.BACKUP_ALERT_TO });
  await assert.rejects(emailOptions({ ...env, EMAIL_FROM: 'injected\r\nheader' }));
  await assert.rejects(emailOptions({ ...env, BACKUP_ALERTS_ENABLED: 'yes' }));
  const file = join(f.directory, 'resend.key'); await writeFile(file, env.RESEND_API_KEY + '\n');
  assert.equal((await emailOptions({ ...env, RESEND_API_KEY: '', RESEND_API_KEY_FILE: file })).key, env.RESEND_API_KEY);
  await assert.rejects(emailOptions({ ...env, RESEND_API_KEY_FILE: file }));
});
test('Resend sends only to configured recipient and sanitizes provider errors', async () => {
  const config = { key: 're_private', from: 'backup@alerts.example.test', to: 'operator@example.test' };
  const email = { subject: 'Backup failed', text: 'Safe fixed message', id: 'unique-id', to: 'attacker@example.test' };
  const send = resendSender(config, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.resend.com/emails'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Idempotency-Key'], email.id); assert.ok(options.signal);
    const body = JSON.parse(options.body); assert.deepEqual(body.to, [config.to]); assert.equal(body.from, config.from);
    return Response.json({ id: 'receipt' });
  } });
  assert.equal(await send(email), 'receipt');
  for (const response of [new Response('re_private', { status: 403 }), Response.json({}), new Response('invalid-json')]) {
    await assert.rejects(resendSender(config, { fetchImpl: async () => response })(email), error => error.code === 'EMAIL_SEND_FAILED' && !error.message.includes(config.key));
  }
});
test('full or unwritable alert storage does not prevent best-effort email or repeat every check', async t => {
  const f = await setup(t), blocked = join(f.directory, 'not-a-directory'); await writeFile(blocked, 'occupied');
  const alerts = backupAlerts({ ...f.options, directory: blocked });
  await alerts.check(f.snapshot('disk full')); assert.equal(f.sent.length, 1);
  await alerts.check(f.snapshot('disk full')); assert.equal(f.sent.length, 1);
  assert.match(alerts.status().error, /could not be saved/);
});
