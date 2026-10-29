export const certification = 'I hereby certify, to the best of my knowledge and belief, that the amounts requested are only for performance in accordance with the specifications, terms, and conditions of the contract. I have reviewed the qualifications of the individuals whose labor costs are being invoiced hereunder and hereby confirm that all individuals meet the minimum labor category education and experience requirements for the specific labor categories for which his or her work is being billed:';
const id = x => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(x);
const text = (x,n=200) => typeof x === 'string' && x.length <= n;
const cents = x => Number.isSafeInteger(x) && x >= 0;
export const isGovernment = c => c?.invoiceTemplate === 'government' || c?.billing?.template === 'government';
export const validDate = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x) && new Date(x+'T12:00:00Z').toISOString().slice(0,10) === x;
export const monthEnd = month => new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0,12)).toISOString().slice(0,10);
const unique = xs => new Set(xs.map(x=>x.id)).size === xs.length;
export function validateBilling(data) {
  try {
    const signers = data.settings.invoiceSigners || [];
    if (!Array.isArray(signers) || signers.length>100 || !unique(signers) || !signers.every(s=>id(s.id)&&text(s.name,100)&&s.name.trim()&&text(s.title,100)&&s.title.trim())) return false;
    for (const c of data.contracts) {
      if (c.invoiceTemplate !== undefined && !['standard','government'].includes(c.invoiceTemplate)) return false;
      const b=c.billing; if (!b) continue;
      if (!['standard','government'].includes(b.template)||!text(b.prefix,40)||!b.prefix.trim()||/[\x00-\x1f<>]/.test(b.prefix)||!Number.isSafeInteger(b.nextNumber)||b.nextNumber<1||b.nextNumber>999999999||!Number.isInteger(b.padding)||b.padding<1||b.padding>9) return false;
      if(b.template!=='government') continue;
      if(!text(b.agreementNumber)||!b.agreementNumber.trim()||!text(b.project)||!b.project.trim()||!Array.isArray(b.taskOrders)||!b.taskOrders.length||b.taskOrders.length>50||!unique(b.taskOrders)||new Set(b.taskOrders.map(o=>o.number)).size!==b.taskOrders.length||!b.taskOrders.every(o=>id(o.id)&&text(o.number,50)&&o.number.trim()&&validDate(o.popStart)&&validDate(o.popEnd)&&o.popEnd>=o.popStart&&cents(o.funding)&&o.funding>0)) return false;
      if(!Array.isArray(b.categories)||!b.categories.length||b.categories.length>100||!unique(b.categories)||new Set(b.categories.map(k=>k.name.toLowerCase())).size!==b.categories.length||!b.categories.every(k=>id(k.id)&&text(k.name,100)&&k.name.trim()&&cents(k.rate)&&k.rate>0)) return false;
      if(!Array.isArray(b.assignments)||new Set(b.assignments.map(a=>a.employeeId)).size!==b.assignments.length||!b.assignments.every(a=>data.employees.some(e=>e.id===a.employeeId)&&b.categories.some(k=>k.id===a.categoryId))) return false;
    }
    for(const s of data.sheets) for(const r of s.rows) if(r.taskOrderId!==undefined && (!id(r.taskOrderId)||!id(r.categoryId)||!text(r.laborCategory,100))) return false;
    for(const i of data.invoices) if(i.government){
      const g=i.government;
      if(g.version!==1||!id(g.taskOrderId)||!/^\d{4}-(0[1-9]|1[0-2])$/.test(g.month)||!text(g.agreementNumber)||!text(g.taskOrderNumber,50)||!text(g.project)||!validDate(g.popStart)||!validDate(g.popEnd)||!cents(g.funding)||g.funding<1||!cents(g.cumulativeAmount)||!Number.isFinite(g.cumulativeHours)||g.cumulativeHours<0||!cents(g.remaining)||g.remaining!==g.funding-g.cumulativeAmount||!text(g.signerName,100)||!text(g.signerTitle,100)||!text(g.certification,2000)||!Array.isArray(g.rows)||!g.rows.length) return false;
      if(!g.rows.every(r=>id(r.employeeId)&&id(r.categoryId)&&text(r.employee,100)&&text(r.category,100)&&cents(r.rate)&&r.rate>0&&Number.isFinite(r.hours)&&r.hours>=0&&cents(r.amount)&&Number.isFinite(r.cumulativeHours)&&r.cumulativeHours>=r.hours&&cents(r.cumulativeAmount)&&r.cumulativeAmount>=r.amount))return false;
      if(data.invoices.filter(other=>other.contractId===i.contractId&&other.government?.taskOrderId===g.taskOrderId&&other.government.month===g.month).length!==1)return false;
      const earlier=data.invoices.filter(other=>other.contractId===i.contractId&&other.government?.taskOrderId===g.taskOrderId&&other.government.month<g.month);
      if(earlier.some(other=>!other.sentDate))return false;
      const expected=new Map();
      for(const l of [...earlier.flatMap(other=>other.lines),...i.lines]){
        const key=[l.employeeId,l.categoryId,l.rate].join('|');
        if(!expected.has(key))expected.set(key,{hours:0,amount:0});
        expected.get(key).hours+=l.hours;expected.get(key).amount+=l.amount;
      }
      if(expected.size!==g.rows.length||!g.rows.every(r=>{const value=expected.get([r.employeeId,r.categoryId,r.rate].join('|'));return value&&value.hours===r.cumulativeHours&&value.amount===r.cumulativeAmount}))return false;
      if(g.rows.reduce((n,r)=>n+r.amount,0)!==i.lines.reduce((n,l)=>n+l.amount,0)||g.rows.reduce((n,r)=>n+r.cumulativeAmount,0)!==g.cumulativeAmount||g.rows.reduce((n,r)=>n+r.cumulativeHours,0)!==g.cumulativeHours)return false;
    }
    return true;
  }catch{return false;}
}
export function rowTerms(c,employeeId,row) {
  if(!isGovernment(c))return {rate:c.rate};
  const b=c.billing,category=b?.categories?.find(k=>k.id===b.assignments.find(a=>a.employeeId===employeeId)?.categoryId),order=b?.taskOrders?.find(o=>o.id===row.taskOrderId);
  if(!category||!order)throw Error('Configure this employee’s labor category and select a task order before submitting time.');
  if(Object.entries(row.hours||{}).some(([date,h])=>h>0&&(date<order.popStart||date>order.popEnd)))throw Error('Time entries must fall within the task order period of performance.');
  return {rate:category.rate,categoryId:category.id,laborCategory:category.name,taskOrderId:order.id};
}
export function nextNumber(data,c) {
  const b=c.billing;
  let n=b?.nextNumber || Math.max(1000,...data.invoices.map(i=>/^INV-\d+$/.test(i.number)?Number(i.number.slice(4)):0))+1;
  const prefix=b?.prefix||'INV-', padding=b?.padding||1;
  while(data.invoices.some(i=>i.number===prefix+String(n).padStart(padding,'0')))n++;
  return {number:prefix+String(n).padStart(padding,'0'),next:n+1};
}
export function governmentInvoice(data,input,invoiceId) {
  const c=data.contracts.find(c=>c.id===input.contractId),b=c?.billing;
  if(!c||!isGovernment(c)||b?.template!=='government')throw Error('Complete government invoice setup for this contract first.');
  const order=b.taskOrders.find(o=>o.id===input.taskOrderId),signer=data.settings.invoiceSigners?.find(s=>s.id===input.signerId);
  if(!order||!signer)throw Error('Select a task order and an invoice signer.');
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.month)||!validDate(input.issued)||!validDate(input.due)||input.issued<monthEnd(input.month)||input.due<input.issued)throw Error('Use a calendar month and an invoice date on or after that month ends, with a valid due date.');
  if(data.invoices.some(i=>i.contractId===c.id&&!i.government))throw Error('This contract has standard-format invoices that cannot be assigned to a task order automatically. Use a separate government contract record and enter its history chronologically.');
  const previous=data.invoices.filter(i=>i.contractId===c.id&&i.government?.taskOrderId===order.id);
  if(previous.some(i=>!i.sentDate))throw Error('Mark the previous task-order invoice as sent before creating the next one.');
  if(previous.some(i=>i.government.month>=input.month))throw Error('Create historical invoices oldest first. This task order already has an invoice for this or a later month.');
  const billed=new Set(data.invoices.flatMap(i=>i.lines.flatMap(l=>l.sources.map(s=>s.sheetId+'|'+s.rowId))));
  if(data.sheets.filter(s=>s.start.slice(0,7)===input.month).some(s=>s.rows.some(r=>r.contractId===c.id&&!r.taskOrderId&&Object.values(r.hours).some(h=>h>0))))throw Error('Some time in this month is missing task-order and labor-category details. Complete it before billing.');
  const candidates=data.sheets.filter(s=>s.start.slice(0,7)===input.month).flatMap(s=>s.rows.filter(r=>r.contractId===c.id&&r.taskOrderId===order.id&&Object.values(r.hours).some(h=>h>0)).map(r=>({s,r})));
  if(candidates.some(({r})=>r.status!=='approved'))throw Error('Approve all time for this task order and month before invoicing.');
  const available=candidates.filter(({s,r})=>!billed.has(s.id+'|'+r.id));
  if(!available.length)throw Error('There are no approved, unbilled hours for this task order and month.');
  const groups=new Map();
  for(const {s,r} of available){
    if(!r.categoryId||!r.laborCategory||Object.entries(r.hours).some(([d,h])=>h>0&&(d<order.popStart||d>order.popEnd)))throw Error('Time needs a locked labor category, rate, and valid performance dates.');
    const key=[s.employeeId,r.categoryId,r.rate].join('|'),h=Object.values(r.hours).reduce((a,b)=>a+b,0);
    if(!groups.has(key))groups.set(key,{sources:[],description:c.name,employeeId:s.employeeId,employee:data.employees.find(e=>e.id===s.employeeId).name,categoryId:r.categoryId,laborCategory:r.laborCategory,start:input.month+'-01',end:monthEnd(input.month),hours:0,rate:r.rate,amount:0});
    const line=groups.get(key);line.sources.push({sheetId:s.id,rowId:r.id});line.hours+=h;line.amount=Math.round(line.hours*line.rate);
  }
  const lines=[...groups.values()], rows=new Map();
  for(const line of [...previous.flatMap(i=>i.lines),...lines]){
    const key=[line.employeeId,line.categoryId,line.rate].join('|');
    if(!rows.has(key))rows.set(key,{employeeId:line.employeeId,employee:line.employee,categoryId:line.categoryId,category:line.laborCategory,rate:line.rate,hours:0,amount:0,cumulativeHours:0,cumulativeAmount:0});
    const row=rows.get(key);row.cumulativeHours+=line.hours;row.cumulativeAmount+=line.amount;
    if(lines.includes(line)){row.hours+=line.hours;row.amount+=line.amount;row.employee=line.employee;row.category=line.laborCategory;}
  }
  const cumulativeAmount=[...rows.values()].reduce((n,r)=>n+r.cumulativeAmount,0),cumulativeHours=[...rows.values()].reduce((n,r)=>n+r.cumulativeHours,0);
  if(cumulativeAmount>order.funding)throw Error('Cumulative billing exceeds task-order funding. Update the authorized funding before invoicing.');
  const generated=nextNumber(data,c),number=input.number?.trim()||generated.number;
  if(!text(number,80)||!number.trim()||/[\x00-\x1f<>]/.test(number)||data.invoices.some(i=>i.number===number))throw Error('Use a unique invoice number of at most 80 characters.');
  if(number===generated.number)b.nextNumber=generated.next;
  else if(number.startsWith(b.prefix)&&/^\d+$/.test(number.slice(b.prefix.length)))b.nextNumber=Math.max(b.nextNumber,Number(number.slice(b.prefix.length))+1);
  const invoice={id:invoiceId,number,contractId:c.id,client:c.client,contract:c.name,email:c.email,address:c.address,business:{business:data.settings.business,email:data.settings.email,address:data.settings.address,paymentNote:data.settings.paymentNote,schedule:data.settings.schedule},issued:input.issued,due:input.due,sentDate:null,lines,payments:[],note:'',government:{version:1,certification,taskOrderId:order.id,month:input.month,agreementNumber:b.agreementNumber,taskOrderNumber:order.number,project:b.project,popStart:order.popStart,popEnd:order.popEnd,funding:order.funding,cumulativeAmount,cumulativeHours,remaining:order.funding-cumulativeAmount,signerName:signer.name,signerTitle:signer.title,rows:[...rows.values()]}};
  data.invoices.push(invoice);return invoice;
}
