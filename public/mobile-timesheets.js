let timesheetMode='auto',timesheetDay='',mobileMenuOpen=false;
const mobileTimesheetQuery=matchMedia('(max-width:900px)');
const useDayTimesheet=()=>timesheetMode==='day'||(timesheetMode==='auto'&&mobileTimesheetQuery.matches);
function setTimesheetMode(mode){timesheetMode=mode;render()}
function toggleMobileNavigation(){
 mobileMenuOpen=!mobileMenuOpen;document.querySelector('.sidebar')?.classList.toggle('mobile-menu-open',mobileMenuOpen);
 document.querySelector('.mobile-menu-toggle')?.setAttribute('aria-expanded',String(mobileMenuOpen));
}
function closeMobileNavigation(){if(mobileMenuOpen)toggleMobileNavigation()}
function timesheetViewToggle(){return `<div class="timesheet-view-controls"><div class="segmented" role="group" aria-label="Timesheet view"><button class="${useDayTimesheet()?'selected':''}" aria-pressed="${useDayTimesheet()}" onclick="setTimesheetMode('day')">Day view</button><button class="${useDayTimesheet()?'':'selected'}" aria-pressed="${!useDayTimesheet()}" onclick="setTimesheetMode('grid')">Grid view</button></div></div>`}
function timesheetToolbar(){return `<div class="toolbar"><div class="period-nav"><button aria-label="Previous semi-monthly period" onclick="period=shiftPeriod(period,-1);week=0;render()">${icon('left')}</button><strong>${range(period)}</strong><button aria-label="Next semi-monthly period" onclick="period=shiftPeriod(period,1);week=0;render()">${icon('right')}</button><button class="small" onclick="period=periodFor(today());timesheetDay=today();week=0;render()">Today</button></div>${isOwner()?`<select aria-label="Timesheet employee" onchange="employeeId=this.value;render()">${state.employees.map(e=>`<option value="${e.id}" ${e.id===employeeId?'selected':''}>${esc(e.name)}${e.active?'':' (inactive)'}</option>`).join('')}</select>`:`<span class="row"><span class="avatar">${esc(initials(employee(employeeId).name))}</span>${esc(employee(employeeId).name)}</span>`}</div>`}
function timesheetRowDetails(s,r,editable){
 const c=contract(r.contractId),rowEditable=editable&&r.status==='draft';
 return `<strong>${esc(c.client)}</strong><span class="sub">${esc(c.name)}</span>${governmentRowLabel(r)}<span class="sub">${rowStatusBadge(r)}</span><button class="link small" onclick="rowNote('${r.id}')">${r.note||!rowEditable?'View note':'Add note'}</button>${rowEditable?` <button class="link small danger" onclick="removeRow('${r.id}')" aria-label="Remove ${esc(c.name)} row">Remove row</button>`:''}${rowRecoveryActions(s,r)}${rowFeedback(r)}`;
}
function selectTimesheetDay(date){
 if(!periodDays(period).includes(date)){const input=document.getElementById('timesheet-day');if(input)input.value=timesheetDay;return toast('Choose a date within this timesheet period.')}
 timesheetDay=date;render();
}
function mobileTimesheets(){
 const s=currentSheet(),editable=(!s||s.status!=='submitted')&&employee(employeeId).active;
 if(!periodDays(period).includes(timesheetDay))timesheetDay=today()>=period&&today()<=periodEnd(period)?today():period;
 const sh=s?sheetHours(s):0,dayTotal=s?sum(s.rows.map(r=>r.hours[timesheetDay]||0)):0;
 return (isOwner()&&reviewingFromQueue?'<button class="link" style="margin-bottom:16px" onclick="go(\'approvals\')">← Back to approvals</button>':'')+head('Log your time.','Choose a day and enter hours for each contract.')+timesheetToolbar()+timesheetViewToggle()+`<section class="panel mobile-timesheet timesheet-layout" data-layout="day"><div class="mobile-day-controls"><div class="row between"><button aria-label="Previous day" ${timesheetDay===period?'disabled':''} onclick="selectTimesheetDay(addDays(timesheetDay,-1))">${icon('left')}</button><label>Timesheet day<input id="timesheet-day" aria-label="Timesheet day" type="date" value="${timesheetDay}" min="${period}" max="${periodEnd(period)}" onchange="selectTimesheetDay(this.value)"></label><button aria-label="Next day" ${timesheetDay===periodEnd(period)?'disabled':''} onclick="selectTimesheetDay(addDays(timesheetDay,1))">${icon('right')}</button></div><div class="row between wrap"><strong>${dateObj(timesheetDay).toLocaleDateString('en-US',{weekday:'long',month:'short',day:'numeric'})}</strong><span><strong id="mobile-day-total">${hours(dayTotal)}</strong> hrs this day</span></div><div class="row between wrap mobile-period-line">${sheetStatusSummary(s)}<details class="mobile-period-summary"><summary>Period total: <strong id="mobile-period-total">${hours(sh)}</strong> hrs</summary><p>${range(period)}</p>${isOwner()?`<p>Billable value: <strong id="mobile-billable">${money(s?sum(s.rows.map(r=>Math.round(rowHours(r)*billingRowRate(r,s.employeeId)))):0)}</strong></p><button onclick="exportTimesheets()">Export period CSV</button>`:''}</details></div></div>${s?.rows.length?`<div class="mobile-time-entries">${s.rows.map(r=>`<article class="mobile-time-entry"><div>${timesheetRowDetails(s,r,editable)}</div><div class="mobile-hours-control"><label>Hours for ${fmtDate(timesheetDay)}<input type="number" min="0" max="24" step="0.25" inputmode="decimal" value="${r.hours[timesheetDay]||''}" placeholder="0" aria-label="${esc(contract(r.contractId).name)} ${timesheetDay} hours" ${editable&&r.status==='draft'?'':'disabled'} onchange="changeHours('${r.id}','${timesheetDay}',this)"></label><small>Period row total: <span id="mobile-row-total-${r.id}">${hours(rowHours(r))}</span> hrs</small></div></article>`).join('')}</div>`:empty('A fresh timesheet period','Add a contract to start recording your hours.')}<div class="timesheet-footer"><div>${editable?`<button class="link" onclick="addRowDialog()">${icon('plus')}${s?.status==='approved'?'Add more hours':'Add contract'}</button>`:'<small>Submitted hours are locked for review.</small>'}</div><div class="row wrap">${s&&!s.rows.length?'<button class="danger" onclick="deleteEmptySheet()">Delete empty timesheet</button>':''}${sheetActions(s)}</div><p class="field-help">Submission covers all draft rows in this period, including other dates. Work notes apply to the entire contract row for this period.</p></div></section><p class="field-help" style="margin-top:14px">Use 15-minute increments. Daily totals across all contracts cannot exceed 24 hours. Submitted and approved hours stay locked until withdrawn or reopened.</p>`;
}
function updateMobileTimesheetTotals(){
 const s=currentSheet();if(!s)return;
 document.getElementById('mobile-day-total').textContent=hours(sum(s.rows.map(r=>r.hours[timesheetDay]||0)));
 document.getElementById('mobile-period-total').textContent=hours(sheetHours(s));
 s.rows.forEach(r=>document.getElementById('mobile-row-total-'+r.id).textContent=hours(rowHours(r)));
 const value=document.getElementById('mobile-billable');if(value)value.textContent=money(sum(s.rows.map(r=>Math.round(rowHours(r)*billingRowRate(r,s.employeeId)))));
 const submit=document.getElementById('submit-timesheet');if(submit)submit.disabled=!s.rows.some(r=>r.status==='draft'&&rowHours(r)>0);
}
function syncTimesheetLayout(){
 if(view!=='timesheets'||document.querySelector('.modal'))return;
 const current=document.querySelector('.timesheet-layout');if(!current||current.dataset.layout===(useDayTimesheet()?'day':'grid'))return;
 const active=document.activeElement;if(active?.matches('.timesheet-layout input[type=number]'))active.dispatchEvent(new Event('change',{bubbles:true}));render();
}
mobileTimesheetQuery.addEventListener('change',syncTimesheetLayout);
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!document.querySelector('.modal')&&mobileMenuOpen){closeMobileNavigation();document.querySelector('.mobile-menu-toggle')?.focus()}});
