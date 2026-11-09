let revision = 0, pendingSaves = 0, saveFailure = '', saveQueue = Promise.resolve();
let authMode = 'login', signedInUser = null, accountEmailEnabled = false, publicRegistration = false;
let resetToken = new URLSearchParams(location.hash.slice(1)).get('reset') || '';
let inviteToken = new URLSearchParams(location.hash.slice(1)).get('invite') || '';
let invitationInfo = null, accountRole = 'admin', linkedEmployeeId = '', protectedEmployees = [], workspaces = [], workspaceId = '';

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...options.headers }
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error || 'Request failed.'), { status: response.status });
  return result;
}

function authScreen(message = '') {
  closeModal();
  if (authMode === 'forgot') return forgotScreen();
  if (authMode === 'register' && !invitationInfo && !publicRegistration) authMode = 'login';
  const registering = authMode === 'register';
  document.getElementById('app').innerHTML = `<div style="max-width:440px;margin:10vh auto;padding:24px" class="panel">
    <h1>Timekeeper</h1><p style="margin:12px 0 24px">${invitationInfo ? `Join ${esc(invitationInfo.workspaceName)} as ${esc(invitationInfo.role)}. Use ${esc(invitationInfo.email)}.` : registering ? 'Create your account and workspace.' : 'Sign in to your workspace.'}</p>
    <form id="auth-form" class="stack" onsubmit="event.preventDefault();authenticate(this)">
      <div role="alert">${esc(message)}</div>
      ${registering ? '<label>Your name<input name="name" autocomplete="name" maxlength="100" required></label>' : ''}
      <label>Email<input name="email" type="email" autocomplete="username" maxlength="254" required value="${esc(invitationInfo?.email || '')}"></label>
      <label>Password<input name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" ${registering ? 'minlength="12"' : ''} maxlength="256" required></label>
      ${registering ? '<small>Use at least 12 characters.</small>' : ''}
      <button class="primary" type="submit">${registering ? 'Create account' : 'Sign in'}</button>
      ${!registering && accountEmailEnabled ? '<button type="button" onclick="authMode=\'forgot\';authScreen()">Forgot password?</button>' : ''}
      ${(registering || invitationInfo || publicRegistration) ? `<button type="button" onclick="authMode='${registering ? 'login' : 'register'}';authScreen()">${registering ? 'Already have an account? Sign in' : 'Create an account'}</button>` : '<small>Accounts are invitation-only. Ask your workspace admin for an invitation.</small>'}
    </form></div>`;
}

async function authenticate(form) {
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  form.querySelector('[role=alert]').textContent = '';
  try {
    const fields = new FormData(form);
    await api(`/api/auth/${authMode}`, { method: 'POST', body: JSON.stringify({ ...Object.fromEntries(fields), ...(inviteToken ? { inviteToken } : {}) }) });
    inviteToken = ''; invitationInfo = null; history.replaceState(null, '', location.pathname);
    await loadWorkspace();
  } catch (error) {
    form.querySelector('[role=alert]').textContent = error.message;
  } finally { button.disabled = false; }
}

async function loadWorkspace() {
  const [result, identity] = await Promise.all([api('/api/workspace'), api('/api/auth/me')]);
  signedInUser = identity.user;
  accountRole = result.role; linkedEmployeeId = result.employeeId; workspaceId = result.workspaceId;
  state = accountRole === 'admin' ? upgradeWorkspace(result.data) : result.data;
  protectedEmployees = (result.memberEmployeeIds || []).map(id => state.employees.find(e => e.id === id)).filter(Boolean);
  workspaces = await api('/api/workspaces');
  revision = result.revision;
  role = accountRole; employeeId = linkedEmployeeId;
  period = periodFor(today()); week = 0; view = accountRole === 'admin' ? 'overview' : 'timesheets';
  pendingSaves = 0; saveFailure = ''; storageOK = true;
  closeModal(); render();
}

async function bootstrap() {
  if (resetToken) { history.replaceState(null, '', location.pathname); resetScreen(); return; }
  try {
    const features = await api('/api/auth/features');
    accountEmailEnabled = features.enabled; publicRegistration = features.publicRegistration === true;
  } catch { accountEmailEnabled = false; publicRegistration = false; }
  if (inviteToken) {
    invitationInfo = null;
    try { invitationInfo = await api('/api/invitations/preview', { method: 'POST', body: JSON.stringify({ token: inviteToken }) }); }
    catch (error) { authScreen(error.message); return; }
    try {
      const identity = await api('/api/auth/me');
      if (identity.user.email.toLowerCase() !== invitationInfo.email.toLowerCase()) {
        showModal('Use the invited email', `<p>This invitation is for ${esc(invitationInfo.email)}. You are signed in as ${esc(identity.user.email)}.</p>`, '<button onclick="closeModal()">Cancel</button><button class="primary" onclick="logout()">Sign out and open invited signup</button>');
        return;
      }
      showModal('Join workspace', `<p>Join ${esc(invitationInfo.workspaceName)} as ${esc(invitationInfo.role)} using ${esc(invitationInfo.email)}?</p>`, '<button onclick="logout()">Sign out to use the invited email</button><button class="primary" onclick="acceptInvitation()">Accept invitation</button>');
    } catch (error) {
      if (error.status !== 401) { authScreen('Could not check your sign-in status. Please reload and try again.'); return; }
      authMode = 'register'; authScreen();
    }
    return;
  }
  try { await loadWorkspace(); }
  catch (error) {
    if (error.status === 401) authScreen();
    else authScreen(`Could not load your workspace: ${error.message} Try signing in again.`);
  }
}

function saveLabel() {
  return saveFailure ? 'Unsaved changes · export a backup' : pendingSaves ? 'Saving…' : 'Saved to server';
}

function persistWorkspace() {
  if (saveFailure) { toast('Changes are not saving. Export a backup and reload.'); return; }
  const snapshot = JSON.parse(JSON.stringify(state));
  pendingSaves++;
  saveQueue = saveQueue.then(async () => {
    try {
      if (saveFailure) return;
      const result = await api(accountRole === 'admin' ? '/api/workspace' : '/api/employee/timesheets', { method: 'PUT', body: JSON.stringify(accountRole === 'admin' ? { data: snapshot, revision } : { sheets: snapshot.sheets, revision }) });
      revision = result.revision;
    } catch (error) {
      saveFailure = error.message; storageOK = false;
      showModal('Your changes could not be saved', `<p role="alert">${esc(error.message)}</p><p style="margin-top:12px">Export your changes before reloading. The server copy has not been overwritten.</p>`, '<button onclick="exportBackup()">Export backup</button><button onclick="location.reload()">Reload server copy</button>');
    } finally { pendingSaves--; updateStorageLabel(); }
  });
  updateStorageLabel();
}

async function logout() {
  await saveQueue;
  if (saveFailure) { toast('Export a backup and reload before signing out.'); return; }
  try {
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
    location.reload();
  } catch (error) { toast(error.message); }
}

window.addEventListener('beforeunload', event => {
  if (pendingSaves || saveFailure) { event.preventDefault(); event.returnValue = ''; }
});

function forgotScreen() {
  document.getElementById('app').innerHTML = `<section class="panel" style="max-width:440px;margin:10vh auto;padding:24px">
    <h1>Reset your password</h1><p style="margin:12px 0 24px">Enter your account email to request a reset link.</p>
    <form class="stack" onsubmit="event.preventDefault();requestPasswordReset(this)"><div role="status"></div>
    <label>Email<input name="email" type="email" autocomplete="email" required maxlength="254"></label>
    <button class="primary" type="submit">Send reset link</button>
    <button type="button" onclick="authMode='login';authScreen()">Back to sign in</button></form></section>`;
}
async function requestPasswordReset(form) {
  const button = form.querySelector('button[type=submit]'); button.disabled = true;
  try {
    const result = await api('/api/auth/forgot-password', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.querySelector('[role=status]').textContent = result.message;
  } catch (error) { form.querySelector('[role=status]').textContent = error.message; }
  finally { button.disabled = false; }
}
function resetScreen() {
  document.getElementById('app').innerHTML = `<section class="panel" style="max-width:440px;margin:10vh auto;padding:24px">
    <h1>Choose a new password</h1><p style="margin:12px 0 24px">Use 12–256 characters. All existing sessions will be signed out.</p>
    <form class="stack" onsubmit="event.preventDefault();finishPasswordReset(this)"><div role="alert"></div>
    <label>New password<input name="password" type="password" autocomplete="new-password" required minlength="12" maxlength="256"></label>
    <label>Confirm password<input name="confirmPassword" type="password" autocomplete="new-password" required minlength="12" maxlength="256"></label>
    <button class="primary" type="submit">Save new password</button>
    <button type="button" onclick="resetToken='';authMode='login';bootstrap()">Back to sign in</button></form></section>`;
}
async function finishPasswordReset(form) {
  const button = form.querySelector('button[type=submit]'); button.disabled = true;
  try {
    const fields = new FormData(form);
    if (fields.get('password') !== fields.get('confirmPassword')) throw Error('Passwords do not match.');
    await api('/api/auth/reset-password', { method: 'POST', body: JSON.stringify({ token: resetToken, password: fields.get('password') }) });
    resetToken = ''; authMode = 'login'; authScreen('Password updated. Sign in with your new password.');
  } catch (error) { form.querySelector('[role=alert]').textContent = error.message; }
  finally { button.disabled = false; }
}

// Email links can navigate within an already-open tab without reloading the document.
window.addEventListener('hashchange', () => {
  const params = new URLSearchParams(location.hash.slice(1));
  resetToken = params.get('reset') || '';
  inviteToken = params.get('invite') || '';
  if (resetToken || inviteToken) void bootstrap();
});
