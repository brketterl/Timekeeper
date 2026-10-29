import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { auditStore } from './audit.js';
import { validBackup } from './validation.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const digest = value => createHash('sha256').update(value).digest('hex');
const roles = ['admin', 'employee'];
const rowView = r => ({ id: r.id, contractId: r.contractId, status: r.status, hours: r.hours, note: r.note });
const sheetView = s => ({ id: s.id, employeeId: s.employeeId, start: s.start, status: s.status, rows: s.rows.map(rowView) });
const equal = isDeepStrictEqual;

export function accessStore(db, { onAuditEvent, notificationStatus, retryNotifications } = {}) {
  const audit = auditStore(db, { onEvent: onAuditEvent });
  const log = (session, type, id, summary, details) => audit.record(session.workspace_id, session.user_id, type, id, summary, details);
  const document = workspaceId => {
    const row = db.prepare('SELECT data, revision FROM workspace_documents WHERE workspace_id = ?').get(workspaceId);
    return { data: JSON.parse(row.data), revision: row.revision };
  };
  const members = workspaceId => db.prepare(`SELECT m.user_id AS userId, m.role, m.employee_id AS employeeId,
    u.name, u.email FROM memberships m JOIN users u ON u.id = m.user_id WHERE workspace_id = ? ORDER BY u.email`).all(workspaceId);
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = action(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function write(workspaceId, data, revision) {
    if (!Number.isSafeInteger(revision) || !validBackup(data) || data.version !== 2) throw fail(400, 'Invalid workspace data.');
    const result = db.prepare('UPDATE workspace_documents SET data = ?, revision = revision + 1, updated_at = ? WHERE workspace_id = ? AND revision = ?')
      .run(JSON.stringify(data), Date.now(), workspaceId, revision);
    if (!result.changes) throw fail(409, 'This workspace changed in another tab or account. Export your changes, then reload.');
    db.prepare('UPDATE workspaces SET name = ? WHERE id = ?').run(data.settings.business, workspaceId);
    return { revision: revision + 1 };
  }
  function invitation(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw fail(404, 'Invitation is invalid or unavailable.');
    const invite = db.prepare(`SELECT i.*, w.name AS workspace_name FROM invitations i
      JOIN workspaces w ON w.id = i.workspace_id WHERE token_hash = ?`).get(digest(token));
    if (!invite || invite.accepted_at || invite.revoked_at || invite.expires_at <= Date.now()) throw fail(410, 'Invitation is expired, revoked, or already used.');
    return invite;
  }
  // Called inside a transaction by registration or acceptance. Never bind accounts by client-supplied employee IDs.
  function join(invite, user) {
    if (invite.email.toLowerCase() !== user.email.toLowerCase()) throw fail(403, 'Sign in with the email address this invitation was sent to.');
    if (db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND workspace_id = ?').get(user.id, invite.workspace_id)) throw fail(409, 'You already belong to this workspace.');
    const doc = document(invite.workspace_id);
    let employee = invite.employee_id && doc.data.employees.find(e => e.id === invite.employee_id);
    if (invite.employee_id && (!employee || !employee.active)) throw fail(409, 'The invited employee record is no longer active. Ask an admin for a new invitation.');
    if (employee && employee.email && employee.email.toLowerCase() !== user.email.toLowerCase()) throw fail(409, 'The employee email changed. Ask an admin for a new invitation.');
    if (employee && db.prepare('SELECT 1 FROM memberships WHERE workspace_id = ? AND employee_id = ?').get(invite.workspace_id, employee.id)) throw fail(409, 'This employee record already has an account.');
    if (!employee) {
      employee = { id: randomUUID(), name: user.name, email: user.email, active: true, contracts: [] };
      doc.data.employees.push(employee);
    }
    employee.email = user.email;
    db.prepare('INSERT INTO memberships VALUES (?, ?, ?, ?)').run(user.id, invite.workspace_id, invite.role, employee.id);
    write(invite.workspace_id, doc.data, doc.revision);
    db.prepare('UPDATE invitations SET accepted_at = ? WHERE id = ?').run(Date.now(), invite.id);
    audit.record(invite.workspace_id, user.id, 'invitation.accepted', invite.id, 'Accepted workspace invitation', { role: invite.role });
    return invite.workspace_id;
  }
  function read(session) {
    const doc = document(session.workspace_id);
    const memberEmployeeIds = members(session.workspace_id).map(m => m.employeeId).filter(Boolean);
    if (session.role === 'employee') {
      const employee = doc.data.employees.find(e => e.id === session.employee_id && e.active);
      if (!employee) throw fail(403, 'Your employee record is inactive. Contact an admin.');
      const sheets = doc.data.sheets.filter(s => s.employeeId === employee.id);
      const visibleContracts = new Set([...employee.contracts, ...sheets.flatMap(s => s.rows.map(r => r.contractId))]);
      doc.data = { version: 2, demo: false, settings: { business: doc.data.settings.business, schedule: 'semimonthly' },
        employees: [{ id: employee.id, name: employee.name, email: employee.email, active: employee.active, contracts: employee.contracts }], contracts: doc.data.contracts.filter(c => visibleContracts.has(c.id)).map(c => ({ id: c.id, name: c.name, client: c.client, active: c.active })),
        sheets: sheets.map(sheetView), invoices: [] };
    }
    return { ...doc, role: session.role, employeeId: session.employee_id, workspaceId: session.workspace_id,
      ...(session.role === 'admin' ? { memberEmployeeIds } : {}) };
  }
  function writeAdmin(session, input) {
    return transaction(() => {
      if (!input.data || !validBackup(input.data)) throw fail(400, 'Invalid workspace data.');
      for (const member of members(session.workspace_id)) {
        const employee = input.data.employees.find(e => e.id === member.employeeId);
        if (!employee?.active || employee.email.toLowerCase() !== member.email.toLowerCase()) throw fail(409, 'Keep linked account employee records active with their account email. Remove workspace access first to archive an employee.');
      }
      const before = document(session.workspace_id).data;
      const result = write(session.workspace_id, input.data, input.revision);
      audit.changes(session, before, input.data);
      return result;
    });
  }
  function writeEmployee(session, input) {
    return transaction(() => {
      if (Object.keys(input).some(k => !['sheets', 'revision'].includes(k)) || !Array.isArray(input.sheets)) throw fail(400, 'Only your timesheets may be updated.');
      const doc = document(session.workspace_id), employee = doc.data.employees.find(e => e.id === session.employee_id && e.active);
      if (!employee) throw fail(403, 'Your employee record is inactive.');
      const oldSheets = doc.data.sheets.filter(s => s.employeeId === employee.id);
      if (oldSheets.some(old => !input.sheets.some(s => s.id === old.id))) throw fail(403, 'Existing timesheets cannot be deleted.');
      const incoming = input.sheets.map(s => {
        if (!s || Object.keys(s).some(k => !['id', 'employeeId', 'start', 'status', 'rows'].includes(k)) || s.employeeId !== employee.id || !Array.isArray(s.rows)) throw fail(403, 'Only your own timesheets may be changed.');
        const old = oldSheets.find(x => x.id === s.id);
        if (old && old.start !== s.start) throw fail(403, 'Timesheet dates cannot be changed.');
        if (old?.rows.some(r => r.status !== 'draft' && !s.rows.some(row => row.id === r.id))) throw fail(403, 'Locked rows cannot be removed.');
        const rows = s.rows.map(r => {
          if (!r || Object.keys(r).some(k => !['id', 'contractId', 'status', 'hours', 'note'].includes(k))) throw fail(400, 'Invalid time entry fields.');
          const previous = old?.rows.find(x => x.id === r.id);
          if (previous?.status === 'approved') {
            if (!equal(rowView(previous), r)) throw fail(403, 'Approved hours are locked.');
            return previous;
          }
          if (previous?.status === 'submitted') {
            if (!['submitted', 'draft'].includes(r.status) || !equal({ ...rowView(previous), status: r.status }, r)) throw fail(403, 'Withdraw submitted hours before editing.');
            return { ...previous, status: r.status };
          }
          if (!['draft', 'submitted'].includes(r.status)) throw fail(403, 'Only admins can approve hours.');
          const contract = doc.data.contracts.find(c => c.id === r.contractId);
          if ((!previous || !equal(rowView(previous), r)) && (!contract?.active || !employee.contracts.includes(r.contractId))) throw fail(403, 'Use an active assigned contract.');
          return { ...r, rate: r.status === 'submitted' || !previous ? contract?.rate : previous.rate };
        });
        return { ...s, rows };
      });
      const before = structuredClone(doc.data);
      doc.data.sheets = [...doc.data.sheets.filter(s => s.employeeId !== employee.id), ...incoming];
      const result = write(session.workspace_id, doc.data, input.revision);
      audit.changes(session, before, doc.data);
      return result;
    });
  }
  function changeEmail(session, email, verifiedHash, sessionHash) {
    return transaction(() => {
      const current = db.prepare(`SELECT u.password_hash FROM users u JOIN sessions s ON s.user_id = u.id
        JOIN memberships m ON m.user_id = s.user_id AND m.workspace_id = s.workspace_id
        WHERE u.id = ? AND s.token_hash = ? AND s.expires_at > ?`).get(session.user_id, sessionHash, Date.now());
      if (!current || current.password_hash !== verifiedHash) throw fail(401, 'Please sign in again.');
      if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, session.user_id)) throw fail(409, 'That email is already used by another account.');
      const links = db.prepare('SELECT workspace_id, employee_id FROM memberships WHERE user_id = ?').all(session.user_id);
      for (const link of links) {
        const doc = document(link.workspace_id);
        const employee = doc.data.employees.find(e => e.id === link.employee_id);
        if (!employee) throw fail(409, 'An employee link needs repair before the email can be changed.');
        employee.email = email;
        write(link.workspace_id, doc.data, doc.revision);
        for (const prior of db.prepare('SELECT id FROM invitations WHERE workspace_id=? AND employee_id=? AND accepted_at IS NULL AND revoked_at IS NULL').all(link.workspace_id, employee.id)) audit.record(link.workspace_id, session.user_id, 'invitation.revoked', prior.id, 'Revoked invitation after account email changed', { reason: 'email_changed' });
        db.prepare('UPDATE invitations SET revoked_at = ? WHERE workspace_id = ? AND employee_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(Date.now(), link.workspace_id, employee.id);
      }
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, session.user_id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(session.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.user_id);
    });
  }
  async function route(path, method, session, input) {
    const current = db.prepare('SELECT role, employee_id FROM memberships WHERE user_id = ? AND workspace_id = ?').get(session.user_id, session.workspace_id);
    if (!current) throw fail(401, 'Workspace access has been removed.');
    session = { ...session, ...current };
    if (path === '/api/workspaces' && method === 'GET') return db.prepare(`SELECT w.id, w.name, m.role FROM memberships m
      JOIN workspaces w ON w.id = m.workspace_id WHERE m.user_id = ? ORDER BY w.created_at, w.id`).all(session.user_id);
    if (path === '/api/invitations/accept' && method === 'POST') return transaction(() => ({ workspaceId: join(invitation(input.token), { id: session.user_id, email: session.email, name: session.name }) }));
    if (path === '/api/workspace' && method === 'GET') return read(session);
    if (path === '/api/employee/timesheets' && method === 'PUT') {
      if (session.role !== 'employee') throw fail(403, 'Employee access is required.');
      return writeEmployee(session, input);
    }
    if (session.role !== 'admin') throw fail(403, 'Admin access is required.');
    const employeeMatch = /^\/api\/employees\/([a-zA-Z0-9_-]+)\/remove$/.exec(path);
    if (employeeMatch && method === 'POST') return transaction(() => {
      const employeeId = employeeMatch[1], doc = document(session.workspace_id);
      if (input.revision !== doc.revision) throw fail(409, 'The workspace changed. Reload before removing this person.');
      const employee = doc.data.employees.find(e => e.id === employeeId);
      if (!employee) throw fail(404, 'Employee not found.');
      if (members(session.workspace_id).some(m => m.employeeId === employeeId)) throw fail(409, 'This person has sign-in access. Correct your own email in My account, or remove their workspace access before removing the Team record.');
      const hasHistory = doc.data.sheets.some(s => s.employeeId === employeeId);
      if (hasHistory) employee.active = false;
      else doc.data.employees = doc.data.employees.filter(e => e.id !== employeeId);
      const result = write(session.workspace_id, doc.data, input.revision);
      for (const prior of db.prepare('SELECT id FROM invitations WHERE workspace_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND (employee_id=? OR (employee_id IS NULL AND email=?))').all(session.workspace_id, employeeId, employee.email)) log(session, 'invitation.revoked', prior.id, 'Revoked invitation when removing employee', { reason: 'employee_removed' });
      db.prepare(`UPDATE invitations SET revoked_at = ? WHERE workspace_id = ? AND accepted_at IS NULL
        AND revoked_at IS NULL AND (employee_id = ? OR (employee_id IS NULL AND email = ?))`)
        .run(Date.now(), session.workspace_id, employeeId, employee.email);
      log(session, hasHistory ? 'employee.archived' : 'employee.removed', employeeId, `${hasHistory ? 'Archived' : 'Removed'} employee: ${employee.name}`);
      return { ...result, action: hasHistory ? 'archived' : 'deleted' };
    });
    if (path === '/api/workspace' && method === 'PUT') return writeAdmin(session, input);
    if (path === '/api/timesheet-notifications/retry' && method === 'POST') return retryNotifications(session.workspace_id);
    if (path === '/api/timesheet-notifications/status' && method === 'GET') return notificationStatus(session.workspace_id);
    if (path === '/api/activity' && method === 'GET') return audit.list(session.workspace_id, input.before);
    if (path === '/api/members' && method === 'GET') return members(session.workspace_id);
    if (path === '/api/invitations' && method === 'GET') return db.prepare(`SELECT id, email, role, employee_id AS employeeId,
      expires_at AS expiresAt, accepted_at AS acceptedAt, revoked_at AS revokedAt FROM invitations WHERE workspace_id = ? ORDER BY expires_at DESC`).all(session.workspace_id);
    if (path === '/api/invitations' && method === 'POST') return transaction(() => {
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !roles.includes(input.role)) throw fail(400, 'Provide a valid email and role.');
      if (members(session.workspace_id).some(m => m.email.toLowerCase() === email)) throw fail(409, 'This account already has workspace access.');
      const doc = document(session.workspace_id);
      const matching = doc.data.employees.filter(e => e.email.toLowerCase() === email && e.active);
      const employeeId = input.employeeId || (matching.length === 1 ? matching[0].id : null);
      if (!input.employeeId && matching.length > 1) throw fail(409, 'Choose which employee record to link.');
      if (employeeId) {
        const employee = doc.data.employees.find(e => e.id === employeeId && e.active);
        if (!employee || (employee.email && employee.email.toLowerCase() !== email)) throw fail(400, 'Choose an active employee with that email or no email.');
        if (members(session.workspace_id).some(m => m.employeeId === employeeId)) throw fail(409, 'This employee already has an account.');
      }
      const token = randomBytes(32).toString('hex'), id = randomUUID(), expiresAt = Date.now() + 7 * 86400_000;
      for (const prior of db.prepare('SELECT id FROM invitations WHERE workspace_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL').all(session.workspace_id, email)) log(session, 'invitation.revoked', prior.id, 'Replaced workspace invitation', { reason: 'replacement' });
      db.prepare('UPDATE invitations SET revoked_at = ? WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(Date.now(), session.workspace_id, email);
      db.prepare('INSERT INTO invitations VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)').run(id, session.workspace_id, email, input.role, employeeId, digest(token), session.user_id, expiresAt);
      log(session, 'invitation.created', id, `Invited ${email} as ${input.role}`, { email, role: input.role });
      return { id, token, expiresAt };
    });
    const inviteMatch = /^\/api\/invitations\/([a-zA-Z0-9-]+)$/.exec(path);
    if (inviteMatch && method === 'DELETE') return transaction(() => {
      const result = db.prepare('UPDATE invitations SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(Date.now(), inviteMatch[1], session.workspace_id);
      if (!result.changes) throw fail(404, 'Pending invitation not found.');
      log(session, 'invitation.revoked', inviteMatch[1], 'Revoked workspace invitation');
      return { ok: true };
    });
    const memberMatch = /^\/api\/members\/([a-zA-Z0-9-]+)$/.exec(path);
    if (memberMatch && ['PATCH', 'DELETE'].includes(method)) return transaction(() => {
      const member = members(session.workspace_id).find(m => m.userId === memberMatch[1]);
      if (!member) throw fail(404, 'Member not found.');
      if (method === 'PATCH' && !roles.includes(input.role)) throw fail(400, 'Choose admin or employee.');
      if (member.role === 'admin' && (method === 'DELETE' || input.role !== 'admin') && members(session.workspace_id).filter(m => m.role === 'admin').length <= 1) throw fail(409, 'A workspace must retain at least one admin.');
      if (method === 'DELETE') {
        log(session, 'member.removed', member.userId, `Removed workspace access for ${member.name}`, { previousRole: member.role });
        db.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?').run(session.workspace_id, member.userId);
        db.prepare('DELETE FROM sessions WHERE workspace_id = ? AND user_id = ?').run(session.workspace_id, member.userId);
      } else {
        if (member.role !== input.role) log(session, 'member.role_changed', member.userId, `Changed ${member.name} from ${member.role} to ${input.role}`, { from: member.role, to: input.role });
        db.prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?').run(input.role, session.workspace_id, member.userId);
      }
      return { ok: true };
    });
    throw fail(404, 'Not found.');
  }
  return { invitation, join, transaction, route, changeEmail };
}
