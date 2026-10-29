import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createApp } from '../server/index.js';
import { randomBytes } from 'node:crypto';

// Always isolated, regardless of DATA_DIR or NODE_ENV on the developer/CI host.
const dataDir = mkdtempSync(join(tmpdir(), 'timekeeper-e2e-'));
const emails = [];
// Test-only inbox on loopback; never loaded by the production entrypoint.
const inbox = createServer((req, res) => {
  const to = new URL(req.url, 'http://localhost').searchParams.get('to');
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(emails.filter(email => email.to === to)));
});
inbox.listen(3101, '127.0.0.1');
// Multiple browser workflows share loopback; production keeps the default 20-attempt limit.
const server = createApp({ allowPublicRegistration: true, dataDir, secureCookies: false, allowedOrigin: null, authAttemptLimit: 200,
  accountEmailConfig: { origin: 'http://127.0.0.1:3100', send: async email => { emails.push(email); return 'simulated-account-email'; } },
  backupConfig: { directory: join(dataDir, 'backups'), key: randomBytes(32), intervalMs: 86400_000, retain: 2,
    alerts: { send: async () => 'simulated-email-receipt' },
    operators: ['backup-operator-0@example.test', 'backup-operator-1@example.test'] } });
server.listen(3100, '127.0.0.1');
const closedDataDir = mkdtempSync(join(tmpdir(), 'timekeeper-closed-e2e-'));
const closedServer = createApp({ dataDir: closedDataDir, secureCookies: false, allowedOrigin: null });
closedServer.listen(3102, '127.0.0.1');
const shutdown = () => {
  inbox.close();
  closedServer.close(() => rmSync(closedDataDir, { recursive: true, force: true }));
  server.close(() => rmSync(dataDir, { recursive: true, force: true }));
  setTimeout(() => server.closeAllConnections(), 2000).unref();
};
server.on('error', error => {
  rmSync(dataDir, { recursive: true, force: true });
  console.error(error.message); process.exitCode = 1;
});
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
