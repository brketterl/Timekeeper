import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { loadBackupKey, createArchive, verifyArchive, restoreArchive, listArchives } from '../server/backups.js';

const [command, first, second] = process.argv.slice(2);
try {
  if (command === 'keygen') {
    if (!first) throw Error('Usage: npm run backup:keygen -- /private/path/timekeeper-backup.key');
    const path = resolve(first); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, randomBytes(32).toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
    console.log('Encryption key saved. Keep this file separate from your backups; it cannot be recovered from an archive.');
  } else if (command === 'create') {
    const directory = resolve(process.env.DATA_DIR || '.data');
    const db = new DatabaseSync(join(directory, 'timekeeper.sqlite'), { readOnly: true });
    try { const result = await createArchive(db, resolve(process.env.BACKUP_DIR || join(directory, 'backups')), await loadBackupKey()); console.log('Verified encrypted backup:', result.path); }
    finally { db.close(); }
  } else if (command === 'verify') {
    if (!first) throw Error('Usage: npm run backup:verify -- archive.tkbackup');
    const result = await verifyArchive(resolve(first), await loadBackupKey()); console.log('Backup decrypts and passes database checks. Created:', result.createdAt);
  } else if (command === 'restore') {
    if (!first || !second) throw Error('Usage: npm run backup:restore -- archive.tkbackup /new/nonexistent/restore-directory');
    const result = await restoreArchive(resolve(first), await loadBackupKey(), second); console.log('Restored into:', result.directory, 'All sessions were cleared and pending invitations revoked.');
  } else if (command === 'list') {
    const directory = resolve(process.env.BACKUP_DIR || join(process.env.DATA_DIR || '.data', 'backups'));
    for (const name of await listArchives(directory)) console.log(name);
  } else throw Error('Choose keygen, create, list, verify, or restore. See docs/backups.md.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
