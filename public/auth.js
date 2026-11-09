let revision = 0, pendingSaves = 0, saveFailure = '', saveQueue = Promise.resolve();
let saveBaseline=null,refreshInFlight=false,queuedWrites=[];
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
  revision = result.revision;saveBaseline=structuredClone(state);
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

const syncEqual=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function recordChanges(before,after){
 const changes=[];
 for(const collection of accountRole==='admin'?['employees','contracts','sheets','invoices']:['sheets']){
  const old=new Map((before[collection]||[]).map(record=>[record.id,record])),next=new Map((after[collection]||[]).map(record=>[record.id,record]));
  for(const id of new Set([...old.keys(),...next.keys()])){
   const a=old.get(id)||null,b=next.get(id)||null;
   if(!syncEqual(a,b))changes.push({collection,id,before:a,after:b});
  }
 }
 if(accountRole==='admin')for(const collection of ['settings','metadata']){
  const a=collection==='settings'?before.settings:{demo:before.demo,version:before.version},b=collection==='settings'?after.settings:{demo:after.demo,version:after.version};
  for(const id of new Set([...Object.keys(a),...Object.keys(b)]))if(!syncEqual(a[id]??null,b[id]??null))changes.push({collection,id,before:a[id]??null,after:b[id]??null});
 }
 return structuredClone(changes);
}
function syncIdle(){return !document.hidden&&!pendingSaves&&!saveFailure&&!document.querySelector('.modal,[data-sync-dirty]')&&!document.activeElement?.matches('input,select,textarea,[contenteditable=true]')}
function reconcileSaved(snapshot,remote){
 // Pending local edits stay in place; only untouched records accept the server copy.
 for(const change of recordChanges(snapshot,remote)){
  const {collection,id,before,after}=change;
  if(['settings','metadata'].includes(collection)){
   const target=collection==='settings'?state.settings:state;
   if(syncEqual(target[id]??null,before)){if(after===null)delete target[id];else target[id]=after}
  }else{
   const index=state[collection].findIndex(record=>record.id===id),value=index<0?null:state[collection][index];
   if(!syncEqual(value,before))continue;
   if(after===null){if(index>=0)state[collection].splice(index,1)}else if(index<0)state[collection].push(after);else state[collection][index]=after;
  }
 }
 saveBaseline=structuredClone(state);
}
// Carry server-derived fields (for example locked labor categories) through rapid queued edits.
function rebaseNormalized(base,local,remote){
 if(syncEqual(base,local))return remote===undefined?undefined:structuredClone(remote);
 if(!base||!local||!remote||typeof base!=='object'||typeof local!=='object'||typeof remote!=='object')return local;
 if(Array.isArray(base)){
  if(!Array.isArray(local)||!Array.isArray(remote)||![...base,...local,...remote].every(x=>x&&typeof x==='object'&&x.id))return local;
  return local.map(item=>rebaseNormalized(base.find(x=>x.id===item.id),item,remote.find(x=>x.id===item.id)));
 }
 const result={...local};
 for(const key of new Set([...Object.keys(base),...Object.keys(remote)])){
  const value=rebaseNormalized(base[key],local[key],remote[key]);
  if(value===undefined)delete result[key];else result[key]=value;
 }
 return result;
}
function normalizeQueuedSave(write,remote){
 for(const change of write.changes){
  if(!['employees','contracts','sheets','invoices'].includes(change.collection)||change.after===null)continue;
  const normalized=remote[change.collection].find(record=>record.id===change.id);
  if(!normalized||syncEqual(change.after,normalized))continue;
  const normalize=value=>rebaseNormalized(change.after,value,normalized);
  const localIndex=state[change.collection].findIndex(record=>record.id===change.id);
  if(localIndex>=0)state[change.collection][localIndex]=normalize(state[change.collection][localIndex]);
  for(const queued of queuedWrites){
   if(queued===write)continue;
   for(const next of queued.changes)if(next.collection===change.collection&&next.id===change.id){next.before=normalize(next.before);if(next.after!==null)next.after=normalize(next.after)}
   const index=queued.snapshot[change.collection].findIndex(record=>record.id===change.id);
   if(index>=0)queued.snapshot[change.collection][index]=normalize(queued.snapshot[change.collection][index]);
  }
 }
 saveBaseline=structuredClone(state);
}
function persistWorkspace() {
 if(saveFailure){toast('Changes are not saving. Export a backup and reload.');return}
 const snapshot=structuredClone(state),changes=recordChanges(saveBaseline||snapshot,snapshot),requestedWorkspace=workspaceId;
 const write={snapshot,changes};queuedWrites.push(write);
 saveBaseline=structuredClone(snapshot);pendingSaves++;
 saveQueue=saveQueue.then(async()=>{
  try{
   if(saveFailure||requestedWorkspace!==workspaceId)return;
   if(changes.length){
    const result=await api(accountRole==='admin'?'/api/workspace':'/api/employee/timesheets',{method:'PATCH',body:JSON.stringify({changes})});
    revision=result.revision;normalizeQueuedSave(write,result.data);
    // Avoid changing an open form or an input that has not fired its change event.
    if(!document.querySelector('.modal,[data-sync-dirty]')&&!document.activeElement?.matches('input,select,textarea'))reconcileSaved(snapshot,result.data);
   }
  }catch(error){
   saveFailure=error.message;storageOK=false;
   showModal('Your changes could not be saved',`<p role="alert">${esc(error.message)}</p><p style="margin-top:12px">Export your changes before reloading. The server copy has not been overwritten.</p>`,'<button onclick="exportBackup()">Export backup</button><button onclick="location.reload()">Reload server copy</button>');
  }finally{queuedWrites=queuedWrites.filter(item=>item!==write);pendingSaves--;updateStorageLabel()}
 });
 updateStorageLabel();
}
async function refreshWorkspaceIfIdle(){
 if(refreshInFlight||!workspaceId||!syncIdle()||!syncEqual(state,saveBaseline))return;
 const requestedWorkspace=workspaceId,requestedRevision=revision,baseline=structuredClone(state);refreshInFlight=true;
 try{
  const result=await api('/api/workspace');
  if(requestedWorkspace!==workspaceId||requestedRevision!==revision||!syncIdle()||!syncEqual(state,baseline))return;
  if(result.role!==accountRole){await loadWorkspace();return}
  if(result.revision!==revision||!syncEqual(state,result.data)){state=result.data;revision=result.revision;saveBaseline=structuredClone(state);protectedEmployees=(result.memberEmployeeIds||[]).map(id=>state.employees.find(e=>e.id===id)).filter(Boolean);render()}
 }catch{/* Leave existing data and edits intact; retry on the next idle refresh. */}
 finally{refreshInFlight=false}
}
document.addEventListener('input',event=>event.target.closest('form')?.setAttribute('data-sync-dirty','true'));
document.addEventListener('submit',event=>{const form=event.target;queueMicrotask(()=>{if(pendingSaves)form.removeAttribute('data-sync-dirty')})});
setInterval(refreshWorkspaceIfIdle,20000);
window.addEventListener('focus',refreshWorkspaceIfIdle);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshWorkspaceIfIdle()});

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
