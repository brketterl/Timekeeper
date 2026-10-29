async function acceptInvitation() {
  try {
    await api('/api/invitations/accept', { method: 'POST', body: JSON.stringify({ token: inviteToken }) });
    inviteToken = ''; history.replaceState(null, '', location.pathname); await loadWorkspace();
  } catch (error) { toast(error.message); }
}

async function switchWorkspace(id) {
  await saveQueue;
  if (saveFailure) return toast('Export your unsaved changes and reload first.');
  try { await api('/api/auth/switch', { method: 'POST', body: JSON.stringify({ workspaceId: id }) }); await loadWorkspace(); }
  catch (error) { toast(error.message); }
}

// Sample/reset actions must retain employee records linked to active accounts.
function retainAccounts(data) {
  for (const original of protectedEmployees) {
    const employee = JSON.parse(JSON.stringify(state.employees.find(e => e.id === original.id) || original));
    employee.contracts = employee.contracts.filter(id => data.contracts.some(c => c.id === id));
    const index = data.employees.findIndex(e => e.id === employee.id);
    if (index >= 0) data.employees[index] = employee; else data.employees.push(employee);
  }
  return data;
}

function employeeContractsView() {
  const assigned = state.contracts.filter(c => employee(employeeId).contracts.includes(c.id));
  return head('Your assigned contracts', 'Projects available for your time entries.') + `<div class="contract-grid">${assigned.map(c => `<section class="panel contract-card"><h3>${esc(c.name)}</h3><p>${esc(c.client)}</p><small>${c.active ? 'Active' : 'Inactive'}</small></section>`).join('') || empty('No assigned contracts', 'Ask an admin to assign your projects.')}</div>`;
}

async function loadAccessPanel() {
  const panel = document.getElementById('access-panel'); if (!panel) return;
  try {
    const [members, invites] = await Promise.all([api('/api/members'), api('/api/invitations')]);
    if (!panel.isConnected) return;
    panel.innerHTML = `<section class="panel" style="margin-top:24px"><div class="panelhead"><h2>Workspace access</h2></div><div class="panelbody stack">
      <p>Admins manage the whole workspace. Employees access their own hours and assigned contracts.</p>
      <form class="stack" onsubmit="event.preventDefault();inviteMember(this)">
        <div class="form-grid"><label>Email<input name="email" type="email" maxlength="254" required></label>
        <label>Role<select name="role"><option value="employee">Employee</option><option value="admin">Admin</option></select></label>
        <label class="full">Employee record<select name="employeeId"><option value="">Match email or create a record on acceptance</option>${state.employees.filter(e => e.active && !members.some(m => m.employeeId === e.id)).map(e => `<option value="${esc(e.id)}">${esc(e.name)} · ${esc(e.email || 'No email')}</option>`).join('')}</select></label></div>
        <button class="primary" type="submit">Create invitation link</button><small>Links expire in seven days. When email delivery is enabled, the invitation is emailed automatically. You can also copy the link.</small>
      </form><div id="invite-result" role="status"></div>
      <h3>Members</h3>${members.map(m => `<div class="row wrap between"><div><strong>${esc(m.name)}</strong><br><small>${esc(m.email)} · ${esc(m.role)}</small></div><div class="row"><button onclick="changeMember('${m.userId}','${m.role === 'admin' ? 'employee' : 'admin'}')">Make ${m.role === 'admin' ? 'employee' : 'admin'}</button><button class="danger" onclick="removeMember('${m.userId}')">Remove access</button></div></div>`).join('')}
      <h3>Pending invitations</h3>${invites.filter(i => !i.acceptedAt && !i.revokedAt && i.expiresAt > Date.now()).map(i => `<div class="row between wrap"><span>${esc(i.email)} · ${esc(i.role)}</span><button onclick="revokeInvitation('${i.id}')">Revoke</button></div>`).join('') || '<small>No pending invitations.</small>'}
    </div></section>`;
  } catch (error) { panel.textContent = error.message; }
}

async function inviteMember(form) {
  const button = form.querySelector('button'); button.disabled = true;
  try {
    await saveQueue; if (saveFailure) throw Error('Resolve unsaved changes before inviting users.');
    const result = await api('/api/invitations', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    await loadAccessPanel();
    const target = document.getElementById('invite-result');
    if (target) {
      const delivery = document.createElement('p');
      delivery.textContent = result.emailStatus === 'sent' ? 'Invitation email accepted. You can also share the link below.' : result.emailStatus === 'failed' ? 'The invitation was created, but email delivery failed. Share the link below or create a replacement invitation to retry.' : 'Email delivery is not configured. Share the link below.';
      target.append(delivery);
      const label = document.createElement('label'); label.textContent = 'Copy and share this invitation link (shown once)';
      const input = document.createElement('input'); input.readOnly = true; input.value = `${location.origin}/#invite=${result.token}`;
      label.append(input); target.append(label); input.select();
    }
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}

async function changeMember(id, role) {
  try { await saveQueue; await api(`/api/members/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) }); await loadWorkspace(); view = isOwner() ? 'team' : 'timesheets'; render(); }
  catch (error) { toast(error.message); }
}
function removeMember(id) {
  confirmModal('Remove workspace access?', 'This account will lose access immediately. Historical employee records and hours will remain.', async () => {
    try { await api(`/api/members/${id}`, { method: 'DELETE' }); location.reload(); }
    catch (error) { toast(error.message); }
  });
}
async function revokeInvitation(id) {
  try { await api(`/api/invitations/${id}`, { method: 'DELETE' }); await loadAccessPanel(); }
  catch (error) { toast(error.message); }
}

async function openAccount() {
  await saveQueue;
  if (saveFailure) return toast('Export your unsaved changes and reload first.');
  try {
    const { user } = await api('/api/auth/me');
    showModal('My account', `<form id="account-email-form" class="stack" onsubmit="event.preventDefault();changeAccountEmail(this)">
      <div id="form-error"></div><p>Correct your sign-in email here. Your employee records will update in every workspace; your hours and invoices will stay in place.</p>
      <label>Email<input name="email" type="email" maxlength="254" autocomplete="email" required value="${esc(user.email)}"></label>
      <label>Confirm email<input name="confirmEmail" type="email" maxlength="254" required></label>
      <label>Current password<input name="currentPassword" type="password" maxlength="256" autocomplete="current-password" required></label>
      <small>Use your new email next time you sign in. Other signed-in sessions will be signed out. No confirmation email is sent.</small>
      </form>`, '<button onclick="closeModal()">Cancel</button><button class="primary" type="submit" form="account-email-form">Update email</button>');
  } catch (error) { toast(error.message); }
}

async function changeAccountEmail(form) {
  const fields = new FormData(form);
  const email = fields.get('email').trim().toLowerCase();
  if (email !== fields.get('confirmEmail').trim().toLowerCase()) return formError('The email addresses do not match.');
  const button = document.querySelector('[form=account-email-form]'); button.disabled = true;
  try {
    await saveQueue; if (saveFailure) throw Error('Resolve unsaved changes first.');
    await api('/api/auth/email', { method: 'PATCH', body: JSON.stringify({ email, currentPassword: fields.get('currentPassword') }) });
    form.reset();
    const previousView = view;
    await loadWorkspace(); view = previousView; render(); toast('Sign-in email updated. Use the new email next time.');
  } catch (error) {
    form.elements.currentPassword.value = '';
    if (form.isConnected) formError(error.message); else toast(error.message);
  } finally { button.disabled = false; }
}

function removeTeamMember(id) {
  const person = employee(id);
  const hasHistory = state.sheets.some(s => s.employeeId === id);
  confirmModal(hasHistory ? 'Archive this team member?' : 'Delete this team member?',
    `${person.name}: ${hasHistory ? 'Hide this person from the active team while keeping their timesheet and invoice history.' : 'Remove this unused employee record.'} Pending invitations linked to this record will also be revoked.`, async () => {
      try {
        await saveQueue; if (saveFailure) throw Error('Resolve unsaved changes before removing people.');
        const result = await api(`/api/employees/${id}/remove`, { method: 'POST', body: JSON.stringify({ revision }) });
        await loadWorkspace(); view = 'team'; render(); toast(result.action === 'archived' ? 'Team member archived; history preserved.' : 'Unused team member deleted.');
      } catch (error) { toast(error.message); }
    });
}
