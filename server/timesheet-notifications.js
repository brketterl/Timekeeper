import { randomUUID } from 'node:crypto';

export function timesheetNotifications(db, config, { now = Date.now, autoStart = true, logger = console } = {}) {
  let running = null, timer, stopped = false;
  function enqueue(event) {
    if (!config || !['timesheet.submitted', 'timesheet.approved'].includes(event.type)) return;
    const recipients = event.type === 'timesheet.submitted'
      ? db.prepare("SELECT user_id FROM memberships WHERE workspace_id=? AND role='admin' AND user_id<>?").all(event.workspaceId, event.actorId)
      : db.prepare('SELECT user_id FROM memberships WHERE workspace_id=? AND employee_id=?').all(event.workspaceId, event.details.employeeId);
    for (const recipient of recipients) db.prepare(`INSERT OR IGNORE INTO timesheet_notifications
      (id,event_id,user_id,attempts,next_attempt_at,sent_at,cancelled_at,last_error) VALUES(?,?,?,0,?,NULL,NULL,NULL)`)
      .run(randomUUID(), event.id, recipient.user_id, now());
  }
  function status(workspaceId) {
    const counts = db.prepare(`SELECT
      COALESCE(SUM(n.sent_at IS NOT NULL),0) AS accepted,
      COALESCE(SUM(n.sent_at IS NULL AND n.cancelled_at IS NULL AND n.attempts<5),0) AS pending,
      COALESCE(SUM(n.sent_at IS NULL AND n.cancelled_at IS NULL AND n.attempts>=5),0) AS failed
      FROM timesheet_notifications n JOIN audit_events a ON a.id=n.event_id WHERE a.workspace_id=?`).get(workspaceId);
    return { enabled: Boolean(config), ...counts };
  }
  function retryFailed(workspaceId) {
    if (!config) throw Object.assign(Error('Timesheet emails are disabled.'), { status: 400 });
    const result = db.prepare(`UPDATE timesheet_notifications SET attempts=0,next_attempt_at=?,last_error=NULL
      WHERE sent_at IS NULL AND cancelled_at IS NULL AND attempts>=5
      AND event_id IN (SELECT id FROM audit_events WHERE workspace_id=?)`).run(now(), workspaceId);
    return { queued: result.changes };
  }
  function checkDue() {
    if (!config || stopped) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const rows = db.prepare(`SELECT n.*, a.workspace_id, a.event_type, a.actor_name, a.details,
        w.name AS workspace_name FROM timesheet_notifications n JOIN audit_events a ON a.id=n.event_id
        JOIN workspaces w ON w.id=a.workspace_id WHERE n.sent_at IS NULL AND n.cancelled_at IS NULL
        AND n.attempts<5 AND n.next_attempt_at<=? ORDER BY n.next_attempt_at,n.id LIMIT 20`).all(now());
      for (const row of rows) {
        if (stopped) break;
        const details = JSON.parse(row.details);
        const recipient = db.prepare(`SELECT u.email, m.role, m.employee_id FROM memberships m JOIN users u ON u.id=m.user_id
          WHERE m.workspace_id=? AND m.user_id=?`).get(row.workspace_id, row.user_id);
        if (!recipient || (row.event_type === 'timesheet.submitted' ? recipient.role !== 'admin' : recipient.employee_id !== details.employeeId)) {
          db.prepare('UPDATE timesheet_notifications SET cancelled_at=? WHERE id=?').run(now(), row.id); continue;
        }
        db.prepare('UPDATE timesheet_notifications SET attempts=attempts+1,next_attempt_at=? WHERE id=?').run(now() + 15 * 60_000, row.id);
        try {
          const submitted = row.event_type === 'timesheet.submitted';
          await config.send({ to: recipient.email,
            subject: submitted ? 'Timekeeper: hours submitted for review' : 'Timekeeper: your hours were approved',
            text: `${row.workspace_name}\n\n${submitted ? `${row.actor_name} submitted hours for review.` : 'Hours on your timesheet were approved.'}\nPeriod starting: ${details.period}\nTime-entry rows: ${details.rows}\n\nSign in to view the current timesheet status:\n${config.origin}/\n\nNo billing rates, invoice details, or payment information are included in this notification.`,
            id: `timekeeper-timesheet-${row.id}` });
          db.prepare('UPDATE timesheet_notifications SET sent_at=?,last_error=NULL WHERE id=?').run(now(), row.id);
        } catch {
          db.prepare("UPDATE timesheet_notifications SET last_error='EMAIL_SEND_FAILED' WHERE id=?").run(row.id);
          logger.error('Timesheet notification failed: EMAIL_SEND_FAILED');
        }
      }
    })().catch(() => { logger.error('Timesheet notification queue failed: NOTIFICATION_QUEUE_FAILED'); }).finally(() => { running = null; });
    return running;
  }
  async function tick() {
    await checkDue();
    if (!stopped) { timer = setTimeout(tick, 60_000); timer.unref(); }
  }
  if (autoStart && config) void tick();
  return { enqueue, status, checkDue, retryFailed, async stop() { stopped = true; clearTimeout(timer); if (running) await running; } };
}
