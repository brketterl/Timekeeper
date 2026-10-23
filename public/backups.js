async function loadBackupPanel() {
  const panel = document.getElementById('recovery-backups'); if (!panel) return;
  try {
    const status = await api('/api/backups/status');
    if (!panel.isConnected) return;
    const when = value => value ? esc(new Date(value).toLocaleString()) : 'None yet';
    panel.innerHTML = `<div class="panelhead"><h2>Server recovery backups</h2></div><div class="panelbody stack">
      <p>Encrypted recovery copies include accounts, access permissions, and business records.</p>
      <p>${status.enabled ? `Automatic backups every ${status.intervalHours} hours · keep ${status.retain} copies.` : 'Automatic recovery backups are not enabled. Your server operator needs to configure them.'}</p>
      ${status.enabled ? `<small>Last local copy: ${when(status.lastLocalAt)}<br>Last off-site upload: ${when(status.lastOffsiteAt)}<br>Next attempt: ${when(status.nextRunAt)}</small>
      <p class="note">${status.offsiteConfigured ? 'Off-site uploads are configured. Confirm a recent upload before relying on off-site recovery.' : 'These copies are on the server disk only. Configure Cloudflare R2, Google Drive, or keep downloaded copies elsewhere to protect against losing that disk.'}</p>` : ''}
      ${status.error ? `<p class="error" role="alert">${esc(status.error)}</p>` : ''}
      ${status.alerts?.enabled ? `<small>Email alerts enabled · overdue threshold: ${status.alerts.staleHours} hours<br>Last email accepted: ${when(status.alerts.lastSentAt)}</small>${status.alerts.error ? `<p class="error" role="alert">${esc(status.alerts.error)}</p>` : ''}` : '<small>Email alerts are not configured.</small>'}
      ${status.canDownload && status.alerts?.enabled ? '<button onclick="recoveryAlertDialog()">Send test backup alert</button>' : ''}
      ${status.running ? '<small>A backup is currently running.</small>' : ''}
      ${status.canDownload ? '<button onclick="recoveryDownloadDialog()">Create and download encrypted recovery copy</button>' : ''}
      <button class="small" onclick="loadBackupPanel()">Refresh backup status</button></div>`;
  } catch (error) { panel.textContent = error.message; }
}

function recoveryDownloadDialog() {
  showModal('Download recovery backup', `<form id="recovery-download-form" class="stack" onsubmit="event.preventDefault();downloadRecovery(this)">
    <div id="form-error"></div><p>This encrypted archive includes all hosted workspaces and account records. Keep it private and keep the encryption key separately. Only the designated server backup operator can download it.</p>
    <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label></form>`,
    '<button onclick="closeModal()">Cancel</button><button class="primary" type="submit" form="recovery-download-form">Create and download</button>');
}
async function downloadRecovery(form) {
  const button = document.querySelector('[form=recovery-download-form]'); button.disabled = true;
  try {
    await saveQueue; if (saveFailure) throw Error('Resolve unsaved changes before creating a recovery copy.');
    const response = await fetch('/api/backups/download', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset();
    if (!response.ok) { const result = await response.json(); throw Error(result.error || 'Recovery backup failed.'); }
    const name = /filename="([a-zA-Z0-9.-]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'timekeeper-recovery.tkbackup';
    download(name, await response.blob(), 'application/octet-stream'); closeModal(); await loadBackupPanel(); toast('Encrypted recovery copy downloaded. Keep your key safe.');
  } catch (error) { if (form.isConnected) { form.elements.currentPassword.value = ''; formError(error.message); } else toast(error.message); }
  finally { button.disabled = false; }
}

function recoveryAlertDialog() {
  showModal('Test backup alert email', `<form id="alert-test-form" class="stack" onsubmit="event.preventDefault();testRecoveryAlert(this)">
    <div id="form-error"></div><p>Send a test email to the server’s configured backup alert recipient.</p>
    <label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required maxlength="256"></label></form>`,
    '<button onclick="closeModal()">Cancel</button><button class="primary" type="submit" form="alert-test-form">Send test email</button>');
}
async function testRecoveryAlert(form) {
  const button = document.querySelector('[form=alert-test-form]'); button.disabled = true;
  try {
    await api('/api/backups/test-alert', { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    form.reset(); closeModal(); await loadBackupPanel(); toast('Test email accepted. Check the configured inbox and spam folder.');
  } catch (error) { if (form.isConnected) { form.elements.currentPassword.value = ''; formError(error.message); } }
  finally { button.disabled = false; }
}
