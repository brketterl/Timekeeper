import { readFile } from 'node:fs/promises';

const address = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
export async function emailOptions(env = process.env) {
  if (!env.BACKUP_ALERTS_ENABLED || env.BACKUP_ALERTS_ENABLED === 'false') return null;
  if (env.BACKUP_ALERTS_ENABLED !== 'true') throw Error('BACKUP_ALERTS_ENABLED must be true or false.');
  if (env.RESEND_API_KEY && env.RESEND_API_KEY_FILE) throw Error('Use RESEND_API_KEY or RESEND_API_KEY_FILE, not both.');
  const key = (env.RESEND_API_KEY_FILE ? await readFile(env.RESEND_API_KEY_FILE, 'utf8') : env.RESEND_API_KEY || '').trim();
  if (!/^re_[a-zA-Z0-9_-]+$/.test(key) || !address(env.EMAIL_FROM) || !address(env.BACKUP_ALERT_TO)) {
    throw Error('Backup alerts require a Resend API key, EMAIL_FROM, and BACKUP_ALERT_TO email address.');
  }
  return { key, from: env.EMAIL_FROM, to: env.BACKUP_ALERT_TO };
}

// Bound sender/recipient: callers cannot use the alert endpoint as an email relay.
export function resendSender(config, { fetchImpl = fetch } = {}) {
  return async ({ subject, text, id }) => {
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
        body: JSON.stringify({ from: config.from, to: [config.to], subject, text })
      });
      if (!response.ok) throw Error('Email request rejected.');
      const result = await response.json();
      if (typeof result.id !== 'string' || !result.id) throw Error('Missing email receipt.');
      return result.id;
    } catch {
      // Provider responses can contain credentials or recipient details; don't surface them.
      throw Object.assign(Error('Alert email was not accepted. Check Resend credentials, domain verification, and service status.'), { code: 'EMAIL_SEND_FAILED' });
    }
  };
}
