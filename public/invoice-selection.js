let editingInvoiceId=null,invoiceEntrySelection=new Set();
const invoiceEntryKey=({s,r})=>s.id+'|'+r.id;
function standardInvoiceEntries(cid){
 return state.sheets.flatMap(s=>s.rows.filter(r=>r.contractId===cid&&r.status==='approved'&&rowHours(r)>0&&!state.invoices.some(i=>i.id!==editingInvoiceId&&!i.voided&&i.lines.some(l=>l.sources.some(ref=>ref.sheetId===s.id&&ref.rowId===r.id)))).map(r=>({s,r,amount:Math.round(rowHours(r)*r.rate)}))).sort((a,b)=>b.s.start.localeCompare(a.s.start)||employee(a.s.employeeId).name.localeCompare(employee(b.s.employeeId).name)||a.r.id.localeCompare(b.r.id));
}
function invoiceContractChanged(cid){
 const fields=document.getElementById('standard-invoice-fields'),edit=state.invoices.find(i=>i.id===editingInvoiceId);
 if(!edit&&Billing.isGovernment(contract(cid))){fields.innerHTML='';invoiceEntrySelection=new Set();document.getElementById('invoice-submit').disabled=false;governmentInvoiceFields(cid);invoicePreview(cid);return}
 document.getElementById('government-invoice-fields').innerHTML='';
 const entries=standardInvoiceEntries(cid),periods=[...new Set(entries.map(({s})=>s.start))],refs=edit?.lines.flatMap(l=>l.sources)||[],selectedPeriods=[...new Set(refs.map(ref=>state.sheets.find(s=>s.id===ref.sheetId)?.start))];
 const scope=edit?(selectedPeriods.length===1?selectedPeriods[0]:'all'):(periods[0]||'all');
 invoiceEntrySelection=new Set(edit?refs.map(ref=>ref.sheetId+'|'+ref.rowId):entries.filter(({s})=>scope==='all'||s.start===scope).map(invoiceEntryKey));
 const c=contract(cid),recipient=edit||c;
 fields.innerHTML=`<div class="stack"><label>Billing period<select name="sourcePeriod" onchange="changeInvoicePeriod(this.value)"><option value="all" ${scope==='all'?'selected':''}>All available periods</option>${periods.map(start=>`<option value="${start}" ${scope===start?'selected':''}>${range(start)}</option>`).join('')}</select></label><p class="field-help">Only checked entries will be billed. Changing the period resets the selection to entries in that period. Choose All available periods to select across periods.</p><div class="row wrap"><button type="button" onclick="selectInvoiceEntries(true)">Select all shown</button><button type="button" onclick="selectInvoiceEntries(false)">Clear selection</button></div><div id="invoice-entry-list" class="stack"></div><fieldset class="form-grid"><legend>Bill to</legend><label class="full">Client / company<input name="client" required maxlength="100" value="${esc(recipient.client)}"></label><label class="full">Billing email<input name="email" type="email" maxlength="150" value="${esc(recipient.email)}"></label><label class="full">Billing address<textarea name="address" maxlength="500">${esc(recipient.address)}</textarea></label></fieldset></div>`;
 renderInvoiceEntryChoices();updateStandardInvoicePreview();
}
function visibleInvoiceEntries(){const form=document.getElementById('invoice-form'),cid=editingInvoiceId?state.invoices.find(i=>i.id===editingInvoiceId)?.contractId:form.elements.contract.value,scope=form.elements.sourcePeriod.value;return standardInvoiceEntries(cid).filter(({s})=>scope==='all'||s.start===scope)}
function renderInvoiceEntryChoices(){
 const entries=visibleInvoiceEntries();document.getElementById('invoice-entry-list').innerHTML=entries.length?entries.map(entry=>`<label class="check invoice-entry"><input type="checkbox" name="entries" value="${invoiceEntryKey(entry)}" ${invoiceEntrySelection.has(invoiceEntryKey(entry))?'checked':''} onchange="toggleInvoiceEntry(this.value,this.checked)"><span><strong>${esc(employee(entry.s.employeeId).name)}</strong><span class="sub">${range(entry.s.start)} · ${hours(rowHours(entry.r))} hours · ${money(entry.amount)}</span><span class="sub preline">${esc(entry.r.note||contract(entry.r.contractId).name)}</span></span></label>`).join(''):'<p class="note">No approved entries are available for this period.</p>';
}
function changeInvoicePeriod(){invoiceEntrySelection=new Set(visibleInvoiceEntries().map(invoiceEntryKey));renderInvoiceEntryChoices();updateStandardInvoicePreview()}
function selectInvoiceEntries(selected){invoiceEntrySelection=new Set(selected?visibleInvoiceEntries().map(invoiceEntryKey):[]);renderInvoiceEntryChoices();updateStandardInvoicePreview()}
function toggleInvoiceEntry(key,selected){if(selected)invoiceEntrySelection.add(key);else invoiceEntrySelection.delete(key);updateStandardInvoicePreview()}
function updateStandardInvoicePreview(){
 const form=document.getElementById('invoice-form');if(!form)return;const cid=editingInvoiceId?state.invoices.find(i=>i.id===editingInvoiceId)?.contractId:form.elements.contract.value,lines=standardInvoiceEntries(cid).filter(entry=>invoiceEntrySelection.has(invoiceEntryKey(entry)));
 document.getElementById('invoice-preview').innerHTML=`<strong>${hours(sum(lines.map(entry=>rowHours(entry.r))))} hours · ${money(sum(lines.map(entry=>entry.amount)))}</strong><br>${lines.length} selected ${lines.length===1?'entry':'entries'} across ${new Set(lines.map(entry=>entry.s.start)).size} semi-monthly period(s).`;
 document.getElementById('invoice-footer-summary').textContent=`${hours(sum(lines.map(entry=>rowHours(entry.r))))} hrs · ${money(sum(lines.map(entry=>entry.amount)))}`;
 document.getElementById('invoice-submit').disabled=!lines.length;
}
function editInvoiceDialog(id){const invoice=state.invoices.find(i=>i.id===id);if(!isOwner()||!invoice||invoice.sentDate||invoice.voided||invoice.government)return;newInvoiceDialog(id)}
function saveStandardInvoice(form,c){
 const f=new FormData(form),edit=state.invoices.find(i=>i.id===editingInvoiceId);
 if(editingInvoiceId&&(!edit||edit.sentDate||edit.voided||edit.government))return formError('Only an unsent standard invoice can be edited.');
 if(f.get('due')<f.get('issued'))return formError('The due date must be on or after the invoice date.');
 const selected=standardInvoiceEntries(c.id).filter(entry=>invoiceEntrySelection.has(invoiceEntryKey(entry)));
 if(!selected.length)return formError('Select at least one approved entry.');
 if(selected.length!==invoiceEntrySelection.size)return formError('Some selected hours are no longer available. Reopen the form and review your selection.');
 if(sum(selected.map(entry=>entry.amount))<1)return formError('The invoice total must be at least $0.01.');
 // Retain existing draft lines when all of their source rows remain selected.
 const lines=(edit?.lines||[]).filter(line=>line.sources.every(ref=>invoiceEntrySelection.has(ref.sheetId+'|'+ref.rowId))).map(line=>structuredClone(line)),kept=new Set(lines.flatMap(line=>line.sources.map(ref=>ref.sheetId+'|'+ref.rowId)));
 for(const {s,r,amount} of selected.filter(entry=>!kept.has(invoiceEntryKey(entry))))lines.push({sources:[{sheetId:s.id,rowId:r.id}],description:r.note||c.name,employee:employee(s.employeeId).name,start:s.start,end:periodEnd(s.start),hours:rowHours(r),rate:r.rate,amount});
 const generated=edit?null:Billing.nextNumber(state,c),invoice={...(edit||{id:uid(),number:generated.number,contractId:c.id,contract:c.name,business:{...state.settings},sentDate:null,payments:[]}),client:f.get('client').trim(),email:f.get('email').trim(),address:f.get('address').trim(),issued:f.get('issued'),due:f.get('due'),lines,note:f.get('note').trim()};
 if(!invoice.client)return formError('Enter the client or company name.');
 if(edit)state.invoices[state.invoices.findIndex(i=>i.id===edit.id)]=invoice;else{if(c.billing)c.billing.nextNumber=generated.next;state.invoices.push(invoice)}
 save();closeModal();view='invoices';invoiceFilter='all';render();invoiceDetail(invoice.id);toast(edit?'Draft updated. Its invoice number is unchanged.':'Draft created from the selected entries.');
}
