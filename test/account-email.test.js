import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.js';
import { accountEmailOptions, resendTransport } from '../server/email.js';

const password = 'original secure password', updated = 'updated secure password';
const resetToken = email => /#reset=([a-f0-9]{64})/.exec(email.text)[1];
async function fixture(t, { enabled = true, fail = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'timekeeper-account-mail-')), sent = [];
  const server = createApp({ dataDir: directory, secureCookies: false, allowedOrigin: null,
    accountEmailConfig: enabled ? { origin: 'https://timekeeper.example.test', send: async message => { if (fail) throw Error('provider secret'); sent.push(message); } } : null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await new Promise(r => server.close(r)); await rm(directory, { recursive: true, force: true }); });
  const request = async (path, data, cookie, requestOrigin = origin) => {
    const response = await fetch(origin + path, { method: data ? 'POST' : 'GET', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const db = new DatabaseSync(join(directory, 'timekeeper.sqlite')); t.after(() => db.close());
  const register = (email, name = 'Test owner') => request('/api/auth/register', { email, name, password });
  return { request, register, db, sent };
}
test('reset is generic, hashes tokens, binds recipient, revokes sessions, and is single use', async t => {
  const f = await fixture(t), admin = await f.register('owner@example.test');
  const secondSession = await f.request('/api/auth/login', { email: 'owner@example.test', password });
  const missing = await f.request('/api/auth/forgot-password', { email: 'missing@example.test' });
  const known = await f.request('/api/auth/forgot-password', { email: 'OWNER@example.test', to: 'attacker@example.test' });
  assert.deepEqual(known.body, missing.body); assert.equal(known.status, missing.status);
  await new Promise(r => setImmediate(r)); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].to, 'owner@example.test'); assert.match(f.sent[0].text, /https:\/\/timekeeper.example.test\/#reset=/);
  const token = resetToken(f.sent[0]);
  assert.notEqual(f.db.prepare('SELECT token_hash FROM password_resets').get().token_hash, token);
  await f.request('/api/auth/forgot-password', { email: 'owner@example.test' }); assert.equal(f.sent.length, 1);
  assert.equal((await f.request('/api/auth/reset-password', { token, password: 'short' })).status, 400);
  assert.equal((await f.request('/api/auth/reset-password', { token, password: updated }, null, 'https://attacker.test')).status, 403);
  assert.equal((await f.request('/api/auth/reset-password', { token, password: updated })).status, 200);
  assert.equal((await f.request('/api/auth/me', null, admin.cookie)).status, 401);
  assert.equal((await f.request('/api/auth/me', null, secondSession.cookie)).status, 401);
  assert.equal((await f.request('/api/auth/reset-password', { token, password })).status, 410);
  assert.equal((await f.request('/api/auth/login', { email: 'owner@example.test', password })).status, 401);
  assert.equal((await f.request('/api/auth/login', { email: 'owner@example.test', password: updated })).status, 200);
});
test('reset expiry, replacement, tampering, and concurrent redemption', async t => {
  const f = await fixture(t); await f.register('owner@example.test');
  await f.request('/api/auth/forgot-password', { email: 'owner@example.test' }); await new Promise(r => setImmediate(r));
  const old = resetToken(f.sent[0]);
  f.db.prepare('UPDATE password_resets SET created_at=0').run();
  await f.request('/api/auth/forgot-password', { email: 'owner@example.test' }); await new Promise(r => setImmediate(r));
  const token = resetToken(f.sent[1]);
  assert.equal((await f.request('/api/auth/reset-password', { token: old, password: updated })).status, 410);
  assert.equal((await f.request('/api/auth/reset-password', { token: '0'.repeat(64), password: updated })).status, 410);
  f.db.prepare('UPDATE password_resets SET expires_at=0').run();
  assert.equal((await f.request('/api/auth/reset-password', { token, password: updated })).status, 410);
  await f.request('/api/auth/forgot-password', { email: 'owner@example.test' }); await new Promise(r => setImmediate(r));
  const fresh = resetToken(f.sent.at(-1));
  const outcomes = await Promise.all([f.request('/api/auth/reset-password', { token: fresh, password: updated }), f.request('/api/auth/reset-password', { token: fresh, password: updated })]);
  assert.deepEqual(outcomes.map(x => x.status).sort(), [200, 410]);
});
test('email changes invalidate reset links; disabled and failed delivery disclose no account', async t => {
  const f = await fixture(t), admin = await f.register('owner@example.test');
  await f.request('/api/auth/forgot-password', { email: 'owner@example.test' }); await new Promise(r => setImmediate(r));
  // Simulate the same credential/email binding checks used by account corrections.
  f.db.prepare('UPDATE users SET email=?').run('corrected@example.test');
  assert.equal((await f.request('/api/auth/reset-password', { token: resetToken(f.sent[0]), password: updated })).status, 410);
  for (const options of [{ enabled: false }, { fail: true }]) {
    const disabled = await fixture(t, options); await disabled.register('user@example.test');
    const known = await disabled.request('/api/auth/forgot-password', { email: 'user@example.test' });
    const unknown = await disabled.request('/api/auth/forgot-password', { email: 'absent@example.test' });
    assert.deepEqual(known.body, unknown.body); assert.equal(disabled.sent.length, 0);
  }
});
test('emailed invitations preserve assigned roles and workspace isolation, with manual fallback', async t => {
  const f = await fixture(t), admin = await f.register('admin@example.test'), outside = await f.register('outside@example.test');
  const invitation = await f.request('/api/invitations', { email: 'worker@example.test', role: 'employee', origin: 'https://attacker.test' }, admin.cookie);
  assert.equal(invitation.body.emailStatus, 'sent'); assert.equal(f.sent[0].to, 'worker@example.test');
  assert.match(f.sent[0].text, /as Employee/); assert(f.sent[0].text.includes('https://timekeeper.example.test/#invite=' + invitation.body.token));
  assert(!f.sent[0].text.includes('attacker.test'));
  assert.equal((await f.request('/api/invitations/accept', { token: invitation.body.token }, outside.cookie)).status, 403);
  const worker = await f.request('/api/auth/register', { email: 'worker@example.test', name: 'Worker', password, inviteToken: invitation.body.token });
  assert.equal(worker.status, 201);
  assert.equal((await f.request('/api/auth/me', null, worker.cookie)).body.role, 'employee');
  assert.equal((await f.request('/api/invitations', { email: 'victim@example.test', role: 'admin' }, worker.cookie)).status, 403);
  assert.equal(f.sent.length, 1);
  for (const options of [{ enabled: false }, { fail: true }]) {
    const fallback = await fixture(t, options), owner = await fallback.register('owner@example.test');
    const invite = await fallback.request('/api/invitations', { email: 'join@example.test', role: 'admin' }, owner.cookie);
    assert.equal(invite.status, 200); assert.match(invite.body.token, /^[a-f0-9]{64}$/);
    assert.equal(invite.body.emailStatus, options.fail ? 'failed' : 'disabled');
    assert.equal((await fallback.request('/api/invitations/preview', { token: invite.body.token })).status, 200);
  }
});
test('reset requests are rate limited', async t => {
  const f = await fixture(t, { enabled: false });
  for (let i = 0; i < 20; i++) assert.equal((await f.request('/api/auth/forgot-password', { email: 'unknown@example.test' })).status, 200);
  assert.equal((await f.request('/api/auth/forgot-password', { email: 'unknown@example.test' })).status, 429);
});
test('account email config is independent of alerts; transport uses validated account recipient', async () => {
  const env = { AUTH_EMAIL_ENABLED: 'true', RESEND_API_KEY: 're_fake', EMAIL_FROM: 'backup@alerts.example.test', BACKUP_ALERTS_ENABLED: 'false' };
  assert.equal((await accountEmailOptions(env)).from, env.EMAIL_FROM);
  assert.equal(await accountEmailOptions({}), null);
  await assert.rejects(accountEmailOptions({ ...env, AUTH_EMAIL_ENABLED: 'yes' }));
  let recipient;
  const send = resendTransport({ key: 're_fake', from: env.EMAIL_FROM }, { fetchImpl: async (_, options) => { recipient = JSON.parse(options.body).to; return Response.json({ id: 'receipt' }); } });
  await send({ to: 'member@example.test', subject: 'Invitation', text: 'Test', id: 'fake' }); assert.deepEqual(recipient, ['member@example.test']);
  await assert.rejects(send({ to: 'bad\r\naddress', subject: 'Test' }));
});
