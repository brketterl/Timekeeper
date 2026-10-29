async function loadTimesheetNotifications() {
  const target = document.getElementById('timesheet-notifications'); if (!target) return;
  const requestedWorkspace = workspaceId;
  try {
    const status = await api('/api/timesheet-notifications/status');
    if (!target.isConnected || workspaceId !== requestedWorkspace) return;
    target.innerHTML = `<div class="panelhead"><h2>Timesheet email notifications</h2></div><div class="panelbody stack">
      <p>${status.enabled ? 'Submission and approval emails are enabled.' : 'Timesheet emails are disabled. Your server operator can enable them.'}</p>
      <small>${esc(status.pending)} pending · ${esc(status.accepted)} accepted by email provider · ${esc(status.failed)} failed after retries</small>
      ${status.failed ? '<p class="error" role="alert">Some timesheet emails could not be sent. Check Resend configuration and server logs. Timesheet changes remain saved.</p>' : ''}
      ${status.enabled && status.failed ? '<button onclick="retryTimesheetNotifications(this)">Retry failed emails</button>' : ''}
      <button class="small" onclick="loadTimesheetNotifications()">Refresh email status</button></div>`;
  } catch (error) { if (target.isConnected) target.textContent = error.message; }
}

async function retryTimesheetNotifications(button) {
  button.disabled = true;
  try {
    const result = await api('/api/timesheet-notifications/retry', { method: 'POST', body: '{}' });
    toast(`${result.queued} failed email(s) queued for retry.`); await loadTimesheetNotifications();
  } catch (error) { toast(error.message); button.disabled = false; }
}
