let activityRequest = 0;
function activityView() {
  return head('Workspace activity', 'Who changed what, and when.', '<button onclick="loadActivity()">Refresh activity</button>') +
    '<section class="panel"><div class="panelbody"><p class="muted">History starts when audit logging is enabled. Times use your device’s time zone.</p><div id="activity-list" aria-live="polite">Loading activity…</div></div></section>';
}
async function loadActivity(before = null) {
  const target = document.getElementById('activity-list'); if (!target) return;
  const requestedWorkspace = workspaceId, requestId = ++activityRequest;
  const button = target.querySelector('[data-older]'); if (button) button.disabled = true;
  try {
    await saveQueue;
    const result = await api('/api/activity' + (before ? '?before=' + encodeURIComponent(before) : ''));
    if (!target.isConnected || workspaceId !== requestedWorkspace || requestId !== activityRequest) return;
    if (!before) target.innerHTML = '';
    target.querySelector('[data-older]')?.remove();
    for (const event of result.events) {
      const article = document.createElement('article'); article.style.cssText = 'padding:16px 0;border-bottom:1px solid var(--line)';
      const details = event.details;
      article.innerHTML = `<div class="row between wrap"><strong>${esc(event.summary)}</strong><small>${esc(new Date(event.createdAt).toLocaleString())}</small></div>
        <p class="muted">${esc(event.actorName)} · ${esc(event.actorRole === 'admin' ? 'Admin' : 'Employee')}</p>
        ${details.period ? `<small>Period starting ${esc(details.period)}${details.rows ? ` · ${esc(details.rows)} row(s)` : ''}</small>` : ''}
        ${typeof details.amount === 'number' ? `<small>${esc(money(details.amount))}${details.date ? ` · ${esc(details.date)}` : ''}</small>` : ''}`;
      target.append(article);
    }
    if (!result.events.length && !before) target.textContent = 'No activity recorded yet.';
    if (result.nextCursor) {
      const older = document.createElement('button'); older.dataset.older = 'true'; older.textContent = 'Load older activity'; older.style.marginTop = '16px';
      older.onclick = () => loadActivity(result.nextCursor); target.append(older);
    }
  } catch (error) {
    if (target.isConnected && workspaceId === requestedWorkspace && requestId === activityRequest) {
      if (!before) target.textContent = error.message; else toast(error.message);
      if (button?.isConnected) button.disabled = false;
    }
  }
}
