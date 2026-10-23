import { readFile, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STALE = 48 * 3600_000, RETRY = 15 * 60_000;
export function backupAlerts({ directory, send, now = Date.now, logger = console }) {
  const path = join(directory, 'backup-alert-status.json');
  let state = { startedAt: now(), incident: null, pending: null, lastSentAt: null, lastAttemptAt: null, error: null };
  let queue = Promise.resolve(), ready, storageWarning = false;
  async function persist() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const partial = `${path}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      await rename(partial, path);
    } finally { await rm(partial, { force: true }).catch(() => {}); }
  }
  async function save() {
    try { await persist(); storageWarning = false; }
    catch {
      storageWarning = true;
      state.error = 'Alert state could not be saved. Check disk space and permissions; email deduplication may not survive a restart.';
      logger.error('Backup alert state could not be saved: ALERT_STORAGE_FAILED');
    }
  }
  ready = (async () => {
    try {
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if (!Number.isFinite(saved.startedAt) || saved.startedAt > now() ||
        (saved.incident !== null && (!['failure', 'stale'].includes(saved.incident?.kind) || typeof saved.incident.id !== 'string')) ||
        (saved.pending !== null && (!['failure', 'stale', 'recovered'].includes(saved.pending?.kind) || typeof saved.pending.id !== 'string'))) throw Error('Invalid alert checkpoint.');
      state = saved;
    } catch (error) { if (error.code !== 'ENOENT') logger.error('Backup alert checkpoint could not be loaded.'); }
    await save();
  })();
  ready.catch(() => {});
  const status = () => ({ enabled: true, staleHours: 48, lastSentAt: state.lastSentAt, error: state.error });
  const message = (kind, snapshot) => {
    const last = snapshot.lastOffsiteAt || 'No successful off-site upload recorded';
    const details = `Last successful off-site upload: ${last}.\nOpen Timekeeper Settings → Server recovery backups to inspect status.\nNo database contents, passwords, or recovery keys are included in this email.`;
    if (kind === 'recovered') return { subject: 'Timekeeper backup recovery confirmed', text: `Off-site backups are succeeding again.\n${details}` };
    if (kind === 'stale') return { subject: 'Timekeeper backup overdue: 48 hours', text: `No successful off-site backup has been recorded for at least 48 hours. Check R2 access and the running Render service.\n${details}` };
    return { subject: 'Timekeeper backup failed', text: `A recovery backup did not complete. Automatic backup retries continue every 15 minutes.\n${details}` };
  };
  function serialized(task) {
    const result = queue.then(task); queue = result.catch(() => {}); return result;
  }
  async function check(snapshot) {
    return serialized(async () => {
      try {
        await ready;
        const last = Date.parse(snapshot.lastOffsiteAt);
        const overdue = now() - (Number.isFinite(last) ? last : state.startedAt) >= STALE;
        const kind = overdue ? 'stale' : snapshot.error ? 'failure' : null;
        if (kind && (!state.incident || (kind === 'stale' && state.incident.kind !== 'stale'))) {
          // Escalate once at 48 hours, rather than emailing every backup retry.
          state.incident = { id: randomUUID(), kind, notified: state.incident?.notified || false };
          state.pending = { id: state.incident.id, kind }; state.lastAttemptAt = null;
        } else if (!kind && state.incident && Number.isFinite(last)) {
          // Only send recovery for an outage whose alert was accepted.
          state.pending = state.incident.notified ? { id: randomUUID(), kind: 'recovered' } : null;
          state.incident = null; state.lastAttemptAt = null;
          if (!state.pending && !storageWarning) state.error = null;
        }
        await save();
        if (!state.pending || (state.lastAttemptAt !== null && now() - state.lastAttemptAt < RETRY)) return;
        state.lastAttemptAt = now(); await save();
        await send({ ...message(state.pending.kind, snapshot), id: `timekeeper-backup-${state.pending.id}` });
        state.lastSentAt = new Date(now()).toISOString();
        if (!storageWarning) state.error = null;
        if (state.incident) state.incident.notified = true;
        state.pending = null; await save();
      } catch {
        state.error = 'Backup alert delivery failed. Check Resend configuration, service status, and writable backup storage.';
        logger.error('Backup alert failed: EMAIL_ALERT_FAILED');
        await save();
      }
    });
  }
  let lastTestAt = -Infinity;
  function test() {
    return serialized(async () => {
      await ready;
      if (now() - lastTestAt < 60_000) throw Error('Wait one minute before sending another test alert.');
      lastTestAt = now();
      await send({ subject: 'Timekeeper backup alert test', text: 'Your Timekeeper backup alert email configuration is working. This test does not create a backup or prove backup recovery. Check Settings for current backup status.', id: `timekeeper-backup-test-${randomUUID()}` });
      state.lastSentAt = new Date(now()).toISOString();
      if (!storageWarning) state.error = null;
      await save();
    });
  }
  return { ready, check, status, test, stop: () => queue };
}
