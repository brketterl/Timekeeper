// Recovery actions retain issued financial records; the server validates each transition.
function deleteEmptySheet(){
 const sheet=currentSheet();if(!sheet||sheet.rows.length)return;
 confirmModal('Delete this empty timesheet?','There are no hours or notes to remove. You can start this period again later.',()=>{
  const current=state.sheets.find(s=>s.id===sheet.id);if(!current||current.rows.length)return;
  state.sheets=state.sheets.filter(s=>s.id!==sheet.id);save();render();toast('Empty timesheet deleted');
 });
}
function archiveContract(id){
 const c=contract(id);if(!isOwner()||!c)return;
 confirmModal(c.active?'Archive this contract?':'Restore this contract?',c.active?'Existing hours, invoices, and assignments will be kept. This contract will be hidden from new time entry.':'This contract will be available for new time entry again.',()=>{c.active=!c.active;save();render();toast(c.active?'Contract restored':'Contract archived')});
}
function deleteUnusedContract(id){
 if(!isOwner())return;
 confirmModal('Delete this unused contract?','The contract and its assignments will be removed. Contracts with timesheet or invoice history must be archived instead.',()=>{
  if(state.sheets.some(s=>s.rows.some(r=>r.contractId===id))||state.invoices.some(i=>i.contractId===id))return toast('This contract has history. Archive it instead.');
  state.contracts=state.contracts.filter(c=>c.id!==id);state.employees.forEach(e=>e.contracts=e.contracts.filter(cid=>cid!==id));save();render();toast('Unused contract deleted');
 });
}
function paymentRecoveryPanel(i){
 if(!i.payments.length)return '';
 return `<section class="payment-history"><h3>Payment corrections</h3><p class="field-help">Reverse an incorrect entry, then record the correct payment. Reversing an entry does not refund money.</p>${i.payments.map(p=>`<div class="stack" style="margin-top:12px"><span>${fmtDate(p.date,true)} · ${money(p.amount)} · ${esc(p.reference||'Payment')}</span>${p.reversed?`<small>Reversed ${fmtDate(p.reversed.date,true)}: ${esc(p.reversed.reason)}</small>`:!i.voided?`<button onclick="correctionDialog('${i.id}','${p.id}')">Reverse payment entry</button>`:''}</div>`).join('')}</section>`;
}
function correctionDialog(id,paymentId){
 if(!isOwner())return;
 const i=state.invoices.find(i=>i.id===id),p=i?.payments.find(p=>p.id===paymentId);if(!i||i.voided||paymentId&&(!p||p.reversed))return;
 const blocked=paymentId?'':Billing.voidBlockReason(state,i);
 if(blocked)return showModal('Cannot void this invoice',`<p>${esc(blocked)}</p>`,`<button onclick="invoiceDetail('${id}')">Back to invoice</button>`);
 showModal(paymentId?'Reverse payment entry':'Void invoice',`<form id="correction-form" onsubmit="event.preventDefault();saveCorrection('${id}','${paymentId||''}',this)"><div id="form-error"></div><p class="note">${paymentId?'The original payment stays in history and stops counting toward the balance. This does not refund money.':'The sent invoice stays in history, its balance becomes zero, and its hours become available for invoicing again.'}</p><label style="margin-top:16px">Reason<textarea name="reason" maxlength="500" required></textarea></label></form>`,`<button onclick="invoiceDetail('${id}')">Cancel</button><button class="danger" type="submit" form="correction-form">${paymentId?'Reverse entry':'Void invoice'}</button>`);
}
function saveCorrection(id,paymentId,form){
 if(!isOwner())return;
 const reason=new FormData(form).get('reason').trim(),i=state.invoices.find(i=>i.id===id);if(!reason)return formError('Enter a reason.');if(!i||i.voided)return;
 if(paymentId){const p=i.payments.find(p=>p.id===paymentId);if(!p||p.reversed)return;p.reversed={date:today(),reason}}
 else{const blocked=Billing.voidBlockReason(state,i);if(blocked)return formError(blocked);i.voided={date:today(),reason}}
 save();render();invoiceDetail(id);toast(paymentId?'Payment entry reversed':'Invoice voided; hours are available to invoice');
}
let undoRemovedRow=null;
function offerRowUndo(original,row,index){
 undoRemovedRow=()=>{
  const sheet=state.sheets.find(s=>s.employeeId===original.employeeId&&s.start===original.start)||{...original,rows:[]};
  if(!employee(original.employeeId)?.active||sheet.rows.some(r=>r.id===row.id)||Object.entries(row.hours).some(([date,value])=>sum(sheet.rows.map(r=>r.hours[date]||0))+value>24)||(!isOwner()&&(!contract(row.contractId)?.active||!employee(original.employeeId).contracts.includes(row.contractId))))return toast('The timesheet changed. Add the row again to restore its hours.');
  if(!state.sheets.includes(sheet))state.sheets.push(sheet);sheet.rows.splice(index,0,row);refreshSheet(sheet);save();render();toast('Draft row restored');
 };
 clearTimeout(toastTimer);document.getElementById('toast').innerHTML='<div class="toast">Draft row removed. <button onclick="const undo=undoRemovedRow;undoRemovedRow=null;undo?.()">Undo</button></div>';toastTimer=setTimeout(()=>document.getElementById('toast').innerHTML='',10000);
}
// Explicit whole-workspace replacements use the restore path, not ordinary edits.
async function replaceWorkspace(data,nextView,message){
 try{await saveQueue;if(saveFailure)throw Error('Resolve unsaved changes before replacing the workspace.');await api('/api/workspace/import',{method:'POST',body:JSON.stringify({data,revision})});await loadWorkspace();view=nextView;render();toast(message)}catch(error){toast(error.message)}
}


let feedbackReturn=null;
function rowFeedback(row){
 const history=row.feedback||[];if(!history.length)return '';
 return `<section class="row-feedback" role="note" aria-label="Reviewer feedback"><strong>${row.status==='draft'?'Changes requested':row.status==='submitted'?'Resubmitted · reviewer feedback':'Reviewer feedback history'}</strong><p>${esc(history.at(-1))}</p>${history.length>1?`<details><summary>Earlier feedback (${history.length-1})</summary>${history.slice(0,-1).map(reason=>`<p>${esc(reason)}</p>`).join('')}</details>`:''}</section>`;
}
function returnWithFeedback(rowIds){
 const sheet=currentSheet();if(!isOwner()||!sheet||!employee(sheet.employeeId).active||!rowIds.length)return;
 const rows=sheet.rows.filter(row=>rowIds.includes(row.id));
 if(rows.length!==rowIds.length||rows.some(row=>!['approved','submitted'].includes(row.status)||billed(sheet,row)))return;
 feedbackReturn={sheetId:sheet.id,rows:rows.map(row=>({id:row.id,status:row.status}))};
 showModal('Return hours for changes',`<form id="feedback-form" onsubmit="event.preventDefault();saveReturnFeedback(this)"><div id="form-error"></div><p class="note">${rows.length===1?'Only this row will return to draft.':`These ${rows.length} rows will return to draft with the same feedback.`} Hours and work notes will be kept. Resubmission and approval are required before invoicing.</p><ul>${rows.map(row=>`<li>${esc(contract(row.contractId).name)} · ${hours(rowHours(row))} hours</li>`).join('')}</ul><label>What needs to change?<textarea name="reason" maxlength="500" required placeholder="For example: Move Tuesday’s 2 hours to the correct project and explain the work performed."></textarea></label><small>The employee will see this beside each affected row. Earlier feedback stays in history.</small></form>`,`<button onclick="closeModal()">Cancel</button><button class="primary" type="submit" form="feedback-form">Return to draft</button>`);
}
function saveReturnFeedback(form){
 if(!isOwner()||!feedbackReturn)return;
 const reason=new FormData(form).get('reason').trim();if(!reason)return formError('Explain what needs to change.');
 const sheet=state.sheets.find(s=>s.id===feedbackReturn.sheetId),rows=feedbackReturn.rows.map(old=>sheet?.rows.find(row=>row.id===old.id&&row.status===old.status));
 if(!sheet||!employee(sheet.employeeId).active||rows.some(row=>!row||billed(sheet,row)))return formError('These rows changed. Close this dialog and review the latest timesheet.');
 if(rows.some(row=>(row.feedback||[]).length>=100))return formError('This row has reached its feedback history limit. Keep it for history and create a new row.');
 for(const row of rows){row.feedback=[...(row.feedback||[]),reason];row.status='draft'}
 refreshSheet(sheet);feedbackReturn=null;save();closeModal();render();toast('Hours returned with correction feedback');
}
