import { readFile } from 'node:fs/promises';

const address = value => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
async function resendOptions(env) {
  if (env.RESEND_API_KEY && env.RESEND_API_KEY_FILE) throw Error('Use RESEND_API_KEY or RESEND_API_KEY_FILE, not both.');
  const key = (env.RESEND_API_KEY_FILE ? await readFile(env.RESEND_API_KEY_FILE, 'utf8') : env.RESEND_API_KEY || '').trim();
  if (!/^re_[a-zA-Z0-9_-]+$/.test(key) || !address(env.EMAIL_FROM)) throw Error('Email delivery requires a Resend API key and EMAIL_FROM address.');
  return { key, from: env.EMAIL_FROM };
}
export async function emailOptions(env = process.env) {
  if (!env.BACKUP_ALERTS_ENABLED || env.BACKUP_ALERTS_ENABLED === 'false') return null;
  if (env.BACKUP_ALERTS_ENABLED !== 'true') throw Error('BACKUP_ALERTS_ENABLED must be true or false.');
  if (!address(env.BACKUP_ALERT_TO)) throw Error('Backup alerts require a BACKUP_ALERT_TO email address.');
  return { ...await resendOptions(env), to: env.BACKUP_ALERT_TO };
}

// The sender is fixed by configuration; account recipients come from validated database records.
export function resendTransport(config, { fetchImpl = fetch } = {}) {
  return async ({ to, subject, text, id }) => {
    if (!address(to)) throw Error('Invalid email recipient.');
    try {
      const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json', 'Idempotency-Key': id },
        body: JSON.stringify({ from: config.from, to: [to], subject, text })
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

export function resendSender(config, options) {
  const send = resendTransport(config, options);
  return message => send({ ...message, to: config.to });
}
export async function accountEmailOptions(env = process.env) {
  if (!env.AUTH_EMAIL_ENABLED || env.AUTH_EMAIL_ENABLED === 'false') return null;
  if (env.AUTH_EMAIL_ENABLED !== 'true') throw Error('AUTH_EMAIL_ENABLED must be true or false.');
  return resendOptions(env);
}

export async function timesheetEmailOptions(env = process.env) {
  if (!env.TIMESHEET_EMAIL_ENABLED || env.TIMESHEET_EMAIL_ENABLED === 'false') return null;
  if (env.TIMESHEET_EMAIL_ENABLED !== 'true') throw Error('TIMESHEET_EMAIL_ENABLED must be true or false.');
  return resendOptions(env);
}
