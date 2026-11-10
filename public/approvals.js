let approvalEntries=[],approvalSearch='',approvalRequest=0,approvalViewWorkspace='',reviewingFromQueue=false;
function approvalsView(){
 if(approvalViewWorkspace!==workspaceId){approvalSearch='';approvalViewWorkspace=workspaceId}
 approvalEntries=[];
 return head('Awaiting approval','Timesheets awaiting approval across all periods, with the oldest periods first.','<button onclick="refreshApprovals()">Refresh approvals</button>')+`<div class="toolbar"><label>Find a submission<input type="search" aria-label="Search approvals" placeholder="Employee name or period…" value="${esc(approvalSearch)}" oninput="approvalSearch=this.value;renderApprovalRows()"></label><small id="approval-total"></small></div><section class="panel" id="approval-results" aria-live="polite">Loading submitted hours…</section><p class="field-help" style="margin-top:14px">Review and approve each whole timesheet. Older mixed-status sheets must be returned as a whole before further work. Older records without a reliable submission date show “Not recorded”.</p>`;
}
function submissionAge(timestamp){
 if(timestamp===null)return '<span class="muted">Not recorded</span>';
 const days=Math.max(0,Math.floor((Date.now()-timestamp)/86400000)),label=days===0?'Under 1 day':days===1?'1 day ago':`${days} days ago`;
 return `<time datetime="${new Date(timestamp).toISOString()}" title="${esc(new Date(timestamp).toLocaleString())}">${label}</time>`;
}
function renderApprovalRows(){
 const target=document.getElementById('approval-results');if(!target)return;
 const query=approvalSearch.trim().toLowerCase(),list=approvalEntries.filter(entry=>`${entry.employeeName} ${entry.start} ${periodEnd(entry.start)} ${range(entry.start)}`.toLowerCase().includes(query));
 document.getElementById('approval-total').textContent=`${approvalEntries.length} timesheet${approvalEntries.length===1?'':'s'} · ${hours(sum(approvalEntries.map(entry=>entry.submittedHours)))} submitted hours`;
 target.innerHTML=!approvalEntries.length?empty('All caught up','No submitted hours are awaiting approval in any period.'):!list.length?empty('No matching submissions','Try a different employee name or period.'):`<div class="table-wrap"><table class="approval-table"><thead><tr><th>Team member</th><th>Period</th><th>Submitted hours</th><th>Waiting since submission</th><th></th></tr></thead><tbody>${list.map(entry=>`<tr><td data-label="Team member"><strong>${esc(entry.employeeName)}</strong>${!entry.active?'<span class="sub">Inactive employee</span>':''}</td><td data-label="Period">${range(entry.start)}</td><td class="num" data-label="Submitted hours">${hours(entry.submittedHours)} hrs</td><td data-label="Waiting since submission">${submissionAge(entry.submittedAt)}</td><td><button onclick="reviewApproval('${entry.sheetId}')" aria-label="Review ${esc(entry.employeeName)} ${entry.start}">Review</button></td></tr>`).join('')}</tbody></table></div>`;
}
async function loadApprovals(){
 const target=document.getElementById('approval-results');if(!target)return;
 const request=++approvalRequest,requestedWorkspace=workspaceId;
 try{await saveQueue;const result=await api('/api/approvals');if(!target.isConnected||request!==approvalRequest||requestedWorkspace!==workspaceId)return;approvalEntries=result.entries;
  const count=document.querySelector('nav button[title=Approvals] .count');if(count){count.textContent=approvalEntries.length;count.hidden=!approvalEntries.length}renderApprovalRows();
 }catch(error){if(target.isConnected&&request===approvalRequest&&requestedWorkspace===workspaceId){target.textContent=error.message;const retry=document.createElement('button');retry.textContent='Retry';retry.onclick=loadApprovals;target.append(retry)}}
}
async function refreshApprovals(){
 try{await saveQueue;if(saveFailure)return toast('Resolve unsaved changes before refreshing approvals.');await loadWorkspace();view='approvals';render()}catch(error){toast(error.message)}
}
async function reviewApproval(id){
 const requestedWorkspace=workspaceId;
 try{await saveQueue;if(saveFailure)return toast('Resolve unsaved changes before reviewing another timesheet.');await loadWorkspace();
  if(workspaceId!==requestedWorkspace)return toast('Workspace changed. Open Approvals in your current workspace.');
  const sheet=state.sheets.find(s=>s.id===id&&s.rows.some(row=>row.status==='submitted'));
  if(!sheet){view='approvals';render();return toast('This submission has already been reviewed or withdrawn.')}
  openSheet(sheet.employeeId,sheet.start,true);
 }catch(error){toast(error.message)}
}
