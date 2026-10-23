import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { fileHash } from './backups.js';

const archiveName = /^timekeeper-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9-]{36}\.tkbackup$/;
export async function r2BackupOptions(env = process.env) {
  const names = { accountId: 'R2_BACKUP_ACCOUNT_ID', bucket: 'R2_BACKUP_BUCKET', accessKeyId: 'R2_BACKUP_ACCESS_KEY_ID', secretAccessKey: 'R2_BACKUP_SECRET_ACCESS_KEY' };
  let config;
  if (env.R2_BACKUP_CREDENTIALS_FILE) {
    try { config = JSON.parse(await readFile(env.R2_BACKUP_CREDENTIALS_FILE, 'utf8')); }
    catch { throw Error('Cannot read R2 backup credentials JSON.'); }
  } else {
    config = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, env[name]]));
    if (!Object.values(config).some(Boolean)) return null;
  }
  if (!config || !Object.keys(names).every(key => typeof config[key] === 'string' && config[key].length)
    || !/^[a-f0-9]{32}$/.test(config.accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)) {
    throw Error('R2 backups require an account ID, bucket, access key ID, and secret access key.');
  }
  return config;
}

export function r2Destination(config, { client = new S3Client({
  region: 'auto', endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', maxAttempts: 3
}) } = {}) {
  const prefix = 'timekeeper/v1/';
  const send = command => client.send(command, { abortSignal: AbortSignal.timeout(120_000) });
  return {
    identity: createHash('sha256').update(`r2|${config.accountId}|${config.bucket}|${prefix}`).digest('hex'),
    async upload(archive, retain) {
      try {
        if (!archiveName.test(archive.name) || !Number.isInteger(retain) || retain < 1 || retain > 30) throw Error('Invalid backup request.');
        const Key = prefix + archive.name, Bucket = config.bucket;
        const bytes = (await stat(archive.path)).size;
        const checksum = await fileHash(archive.path);
        await send(new PutObjectCommand({ Bucket, Key, Body: createReadStream(archive.path), ContentLength: bytes,
          ContentType: 'application/octet-stream', ContentMD5: Buffer.from(await fileHash(archive.path, 'md5'), 'hex').toString('base64') }));
        // Read the stored ciphertext back: metadata alone cannot prove recoverability.
        const stored = await send(new GetObjectCommand({ Bucket, Key }));
        const hash = createHash('sha256'); let received = 0;
        if (!stored.Body || Number(stored.ContentLength) !== bytes) { stored.Body?.destroy?.(); throw Error('Size mismatch.'); }
        for await (const chunk of stored.Body) { hash.update(chunk); received += chunk.length; }
        if (received !== bytes || hash.digest('hex') !== checksum) throw Error('Checksum mismatch.');
        const files = []; const seen = new Set(); let token;
        do {
          const page = await send(new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken: token }));
          if (page.Contents !== undefined && !Array.isArray(page.Contents)) throw Error('Incomplete listing.');
          files.push(...(page.Contents || []).filter(file => typeof file.Key === 'string' && file.Key.startsWith(prefix) && archiveName.test(file.Key.slice(prefix.length))));
          token = page.IsTruncated ? page.NextContinuationToken : undefined;
          if (page.IsTruncated && (!token || seen.has(token))) throw Error('Incomplete listing.');
          seen.add(token);
        } while (token);
        files.sort((a, b) => b.Key.localeCompare(a.Key));
        const keep = new Set([Key, ...files.filter(file => file.Key !== Key).slice(0, retain - 1).map(file => file.Key)]);
        for (const file of files) if (!keep.has(file.Key)) await send(new DeleteObjectCommand({ Bucket, Key: file.Key }));
        return { id: Key };
      } catch {
        // SDK errors can contain request details; expose only an operator-safe message.
        throw Object.assign(Error('R2 backup failed. Check bucket credentials, permissions, connectivity, and storage status.'), { code: 'R2_BACKUP_FAILED' });
      }
    }
  };
}
