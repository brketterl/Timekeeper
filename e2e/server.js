import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.js';
import { randomBytes } from 'node:crypto';

// Always isolated, regardless of DATA_DIR or NODE_ENV on the developer/CI host.
const dataDir = mkdtempSync(join(tmpdir(), 'timekeeper-e2e-'));
const server = createApp({ dataDir, secureCookies: false, allowedOrigin: null,
  backupConfig: { directory: join(dataDir, 'backups'), key: randomBytes(32), intervalMs: 86400_000, retain: 2,
    alerts: { send: async () => 'simulated-email-receipt' },
    operators: ['backup-operator-0@example.test', 'backup-operator-1@example.test'] } });
server.listen(3100, '127.0.0.1');
const shutdown = () => {
  server.close(() => rmSync(dataDir, { recursive: true, force: true }));
  setTimeout(() => server.closeAllConnections(), 2000).unref();
};
server.on('error', error => {
  rmSync(dataDir, { recursive: true, force: true });
  console.error(error.message); process.exitCode = 1;
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
