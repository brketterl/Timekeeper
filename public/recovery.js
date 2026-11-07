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
