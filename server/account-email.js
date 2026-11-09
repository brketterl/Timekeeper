import { randomBytes, randomUUID, createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest('hex');
const invalid = () => Object.assign(Error('Reset link is invalid, expired, or already used. Request a new link.'), { status: 410 });
export function accountEmail(db, config, { hashPassword, now = Date.now, logger = console } = {}) {
  const pending = new Set();
  const status = () => ({ enabled: Boolean(config) });
  const link = (kind, token) => `${config.origin}/#${kind}=${token}`;
  function requestReset(email) {
    if (!config || pending.size >= 20) return;
    const user = db.prepare('SELECT id, email, password_hash FROM users WHERE email=?').get(email);
    if (!user) return;
    const recent = db.prepare('SELECT created_at, expires_at FROM password_resets WHERE user_id=?').get(user.id);
    if (recent && recent.expires_at > now() && now() - recent.created_at < 120_000) return;
    const token = randomBytes(32).toString('hex');
    db.prepare('DELETE FROM password_resets WHERE expires_at<=? OR user_id=?').run(now(), user.id);
    db.prepare('INSERT INTO password_resets VALUES(?,?,?,?,?,?)').run(digest(token), user.id, user.email, digest(user.password_hash), now(), now() + 30 * 60_000);
    // Respond without waiting for email, so delivery timing cannot reveal registered accounts.
    const task = Promise.resolve().then(() => config.send({ to: user.email, subject: 'Reset your Timekeeper password',
      text: `Use this link to choose a new Timekeeper password:\n${link('reset', token)}\n\nThis link expires in 30 minutes and can be used once. If you did not request it, ignore this email.`, id: `timekeeper-reset-${randomUUID()}` }))
      .catch(() => {
        try { db.prepare('DELETE FROM password_resets WHERE token_hash=?').run(digest(token)); }
        catch { /* Storage failures must not turn an email failure into an unhandled rejection. */ }
        logger.error('Password reset email failed: EMAIL_SEND_FAILED');
      }).finally(() => pending.delete(task));
    pending.add(task);
  }
  function lookup(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw invalid();
    const row = db.prepare(`SELECT r.*, u.email AS current_email, u.password_hash FROM password_resets r
      JOIN users u ON u.id=r.user_id WHERE token_hash=?`).get(digest(token));
    if (!row || row.expires_at <= now() || row.email !== row.current_email || row.credential_hash !== digest(row.password_hash)) throw invalid();
    return row;
  }
  async function reset(token, password) {
    const first = lookup(token);
    const passwordHash = await hashPassword(password);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = lookup(token);
      if (current.password_hash !== first.password_hash) throw invalid();
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(passwordHash, current.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.user_id);
      db.prepare('DELETE FROM password_resets WHERE user_id=?').run(current.user_id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  async function invite(result) {
    if (!config) return { ...result, emailStatus: 'disabled' };
    const invite = db.prepare(`SELECT i.email, i.role, w.name FROM invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE i.id=?`).get(result.id);
    try {
      await config.send({ to: invite.email, subject: 'You are invited to Timekeeper',
        text: `You have been invited to ${invite.name} as ${invite.role === 'admin' ? 'Admin' : 'Employee'}.\n\nJoin your workspace:\n${link('invite', result.token)}\n\nUse this email address to create an account, or sign in if you already have one. This link expires in seven days and can be used once.`,
        id: `timekeeper-invite-${result.id}` });
      return { ...result, emailStatus: 'sent' };
    } catch { logger.error('Invitation email failed: EMAIL_SEND_FAILED'); return { ...result, emailStatus: 'failed' }; }
  }
  return { status, requestReset, reset, invite, stop: () => Promise.allSettled([...pending]) };
}
