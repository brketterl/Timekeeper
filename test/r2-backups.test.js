import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { r2BackupOptions, r2Destination } from '../server/r2-backups.js';

const config = { accountId: 'a'.repeat(32), bucket: 'timekeeper-backups', accessKeyId: 'private-id', secretAccessKey: 'private-secret' };
const name = n => `timekeeper-2026-10-${n}T00-00-00-000Z-00000000-0000-0000-0000-000000000000.tkbackup`;
test('R2 configuration is optional and validates credentials without leaking values', async () => {
  assert.equal(await r2BackupOptions({}), null);
  assert.deepEqual(await r2BackupOptions({ R2_BACKUP_ACCOUNT_ID: config.accountId, R2_BACKUP_BUCKET: config.bucket, R2_BACKUP_ACCESS_KEY_ID: config.accessKeyId, R2_BACKUP_SECRET_ACCESS_KEY: config.secretAccessKey }), config);
  await assert.rejects(r2BackupOptions({ R2_BACKUP_ACCOUNT_ID: 'private-secret' }), error => !error.message.includes('private-secret'));
});
for (const failure of [null, 'corrupt', 'listing', 'pagination', 'upload']) test(`R2 verifies stored bytes and scopes paginated retention: ${failure || 'success'}`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'r2-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'archive'), bytes = Buffer.from('encrypted archive bytes'); await writeFile(path, bytes);
  const deleted = [], calls = []; let pages = 0;
  const client = { async send(command) {
    const kind = command.constructor.name, input = command.input; calls.push(kind);
    assert.equal(input.Bucket, config.bucket);
    if (kind === 'PutObjectCommand') {
      let uploaded = Buffer.alloc(0); for await (const chunk of input.Body) uploaded = Buffer.concat([uploaded, chunk]);
      assert.deepEqual(uploaded, bytes); assert.ok(input.ContentMD5);
      if (failure === 'upload') throw Error(config.secretAccessKey);
      return {};
    }
    if (kind === 'GetObjectCommand') return { ContentLength: bytes.length, Body: Readable.from([failure === 'corrupt' ? Buffer.alloc(bytes.length) : bytes]) };
    if (kind === 'ListObjectsV2Command') {
      if (failure === 'listing') throw Error(config.secretAccessKey);
      pages++;
      if (pages === 1) return { Contents: [{ Key: 'timekeeper/v1/' + name('23') }, { Key: 'timekeeper/v1/unrelated.txt' }], IsTruncated: true, NextContinuationToken: 'next' };
      if (failure === 'pagination') return { IsTruncated: true, NextContinuationToken: 'next' };
      assert.equal(input.ContinuationToken, 'next');
      return { Contents: [{ Key: 'timekeeper/v1/' + name('21') }, { Key: 'other/' + name('20') }], IsTruncated: false };
    }
    if (kind === 'DeleteObjectCommand') { deleted.push(input.Key); return {}; }
    assert.fail(kind);
  } };
  const destination = r2Destination(config, { client });
  const run = () => destination.upload({ name: name('23'), path }, 1);
  if (failure) { await assert.rejects(run(), error => error.code === 'R2_BACKUP_FAILED' && !error.message.includes(config.secretAccessKey)); assert.deepEqual(deleted, []); }
  else { await run(); assert.deepEqual(deleted, ['timekeeper/v1/' + name('21')]); assert.equal(pages, 2); }
  if (failure === 'corrupt') assert.ok(!calls.includes('ListObjectsV2Command'));
});
