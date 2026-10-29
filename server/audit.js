import { isDeepStrictEqual as equal } from 'node:util';

// Only server-built summaries/details are accepted here, never request-supplied audit records.
export function auditStore(db, { onEvent = () => {} } = {}) {
  function record(workspaceId, userId, type, entityId, summary, details = {}) {
    const actor = db.prepare(`SELECT u.name, m.role FROM users u LEFT JOIN memberships m ON m.user_id=u.id AND m.workspace_id=? WHERE u.id=?`).get(workspaceId, userId);
    if (!actor?.role) throw Error('An audit actor must belong to the workspace.');
    const safeDetails = Object.fromEntries(Object.entries(details).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 200) : value]));
    const inserted = db.prepare(`INSERT INTO audit_events(workspace_id,actor_id,actor_name,actor_role,event_type,entity_id,summary,details,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(workspaceId, userId, actor.name, actor.role, type, entityId, summary.slice(0, 500), JSON.stringify(safeDetails), Date.now());
    onEvent({ id: Number(inserted.lastInsertRowid), workspaceId, actorId: userId, type, entityId, details: safeDetails });
  }
  function changes(session, before, after) {
    const log = (type, id, text, details) => record(session.workspace_id, session.user_id, type, id, text, details);
    for (const sheet of after.sheets) {
      const old = before.sheets.find(s => s.id === sheet.id);
      const who = after.employees.find(e => e.id === sheet.employeeId)?.name || 'Employee';
      const transitions = new Map(); let edited = 0;
      for (const row of sheet.rows) {
        const previous = old?.rows.find(r => r.id === row.id);
        if (previous?.status !== row.status) {
          const action = row.status === 'submitted' ? 'submitted' : row.status === 'approved' ? 'approved' : previous?.status === 'submitted' ? 'withdrawn' : previous?.status === 'approved' ? 'reopened' : null;
          if (action) transitions.set(action, (transitions.get(action) || 0) + 1);
        } else if (previous && row.status !== 'draft' && !equal(previous, row)) edited++;
      }
      for (const [action, count] of transitions) log(`timesheet.${action}`, sheet.id, `${action[0].toUpperCase() + action.slice(1)} hours for ${who}`, { employeeId: sheet.employeeId, period: sheet.start, rows: count });
      const removed = old?.rows.filter(row => !sheet.rows.some(r => r.id === row.id)).length || 0;
      if (removed) log('timesheet.rows_removed', sheet.id, `Removed time entries for ${who}`, { employeeId: sheet.employeeId, period: sheet.start, rows: removed });
      if (edited) log('timesheet.updated', sheet.id, `Updated locked or submitted hours for ${who}`, { employeeId: sheet.employeeId, period: sheet.start, rows: edited });
    }
    for (const old of before.sheets) if (!after.sheets.some(s => s.id === old.id)) log('timesheet.deleted', old.id, 'Removed timesheet', { employeeId: old.employeeId, period: old.start });
    for (const invoice of after.invoices) {
      const old = before.invoices.find(i => i.id === invoice.id), info = { number: invoice.number };
      if (!old) log('invoice.created', invoice.id, `Created invoice ${invoice.number}`, info);
      else if (!equal({ ...old, payments: [] }, { ...invoice, payments: [] })) log('invoice.updated', invoice.id, `Updated invoice ${invoice.number}`, info);
      for (const payment of invoice.payments) {
        const previous = old?.payments.find(p => p.id === payment.id);
        if (!previous || !equal(previous, payment)) log(previous ? 'payment.updated' : 'payment.recorded', payment.id,
          `${previous ? 'Updated' : 'Recorded'} payment for invoice ${invoice.number}`, { invoiceId: invoice.id, number: invoice.number, amount: payment.amount, date: payment.date });
      }
      for (const oldPayment of old?.payments || []) if (!invoice.payments.some(p => p.id === oldPayment.id)) log('payment.removed', oldPayment.id, `Removed payment for invoice ${invoice.number}`, { invoiceId: invoice.id, number: invoice.number, amount: oldPayment.amount });
    }
    for (const old of before.invoices) if (!after.invoices.some(i => i.id === old.id)) log('invoice.deleted', old.id, `Removed invoice ${old.number}`, { number: old.number });
    for (const [collection, kind] of [['employees', 'employee'], ['contracts', 'contract']]) {
      for (const item of after[collection]) {
        const old = before[collection].find(x => x.id === item.id);
        if (!old || !equal(old, item)) log(`${kind}.${!old ? 'created' : 'updated'}`, item.id, `${!old ? 'Added' : 'Updated'} ${kind}: ${item.name}`);
      }
      for (const old of before[collection]) if (!after[collection].some(x => x.id === old.id)) log(`${kind}.removed`, old.id, `Removed ${kind}: ${old.name}`);
    }
    if (!equal(before.settings, after.settings)) log('workspace.updated', session.workspace_id, 'Updated workspace settings');
  }
  function list(workspaceId, before) {
    if (before !== undefined && before !== null && (!/^\d+$/.test(String(before)) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)) {
      throw Object.assign(Error('Invalid activity cursor.'), { status: 400 });
    }
    const rows = db.prepare(`SELECT id, actor_id AS actorId, actor_name AS actorName, actor_role AS actorRole,
      event_type AS type, entity_id AS entityId, summary, details, created_at AS createdAt FROM audit_events
      WHERE workspace_id=? AND id<? ORDER BY id DESC LIMIT 51`).all(workspaceId, before ? Number(before) : Number.MAX_SAFE_INTEGER);
    const events = rows.slice(0, 50).map(row => ({ ...row, details: JSON.parse(row.details) }));
    return { events, nextCursor: rows.length > 50 ? events.at(-1).id : null };
  }
  return { record, changes, list };
}
