import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { createApp } from '../server/index.js';
import { governmentInvoice, validateBilling, rowTerms, monthEnd } from '../public/billing.js';
import { validBackup } from '../server/validation.js';
import { openDatabase } from '../server/db.js';
import { createArchive, restoreArchive } from '../server/backups.js';
function data(){return {version:2,demo:false,settings:{business:'VTC',email:'billing@example.test',address:'Address',paymentNote:'',schedule:'semimonthly',invoiceSigners:[{id:'signer',name:'Authorized Signer',title:'Partner'}]},employees:[{id:'person',name:'Person',email:'person@example.test',active:true,contracts:['contract']}],contracts:[{id:'contract',name:'Government services',client:'Prime',email:'ap@example.test',address:'Client address',rate:10000,budget:0,active:true,invoiceTemplate:'government',billing:{template:'government',prefix:'C&C-TEST',nextNumber:30,padding:3,agreementNumber:'AGREEMENT-1',project:'Test program',categories:[{id:'rte',name:'RTE II',rate:14500}],assignments:[{employeeId:'person',categoryId:'rte'}],taskOrders:[{id:'order',number:'1',popStart:'2026-01-01',popEnd:'2027-12-31',funding:10000000},{id:'other-order',number:'2',popStart:'2026-01-01',popEnd:'2027-12-31',funding:1000000}]}}],sheets:[],invoices:[]};}
function sheet(d,id,start,hours,rate=14500,order='order') {d.sheets.push({id,employeeId:'person',start,status:'approved',rows:[{id:'row-'+id,contractId:'contract',status:'approved',note:'private note',hours:{[start]:hours},rate,categoryId:'rte',laborCategory:'RTE II',taskOrderId:order}]});}
const input=(month='2026-08',extra={})=>({contractId:'contract',taskOrderId:'order',signerId:'signer',month,issued:monthEnd(month),due:monthEnd(month),...extra});
test('monthly invoice combines semi-monthly sources, numbering, funding and snapshots',()=>{
  const d=data();sheet(d,'first','2026-08-01',8);sheet(d,'second','2026-08-16',4);sheet(d,'other','2026-08-16',1,14500,'other-order');
  // One sheet per employee/period: place the other-order row in the same sheet.
  d.sheets[1].rows.push(d.sheets.pop().rows[0]);
  const invoice=governmentInvoice(d,input(),'invoice');
  assert.equal(invoice.number,'C&C-TEST030');assert.equal(invoice.lines.length,1);assert.equal(invoice.lines[0].sources.length,2);
  assert.equal(invoice.lines[0].hours,12);assert.equal(invoice.government.cumulativeAmount,174000);assert.equal(invoice.government.remaining,10000000-174000);
  assert.equal(invoice.government.signerName,'Authorized Signer');assert.equal(d.contracts[0].billing.nextNumber,31);assert(validBackup(d));
  const frozen=structuredClone(invoice);d.contracts[0].billing.taskOrders[0].funding=99999999;d.settings.invoiceSigners[0].name='Different signer';
  assert.deepEqual(invoice,frozen);
  const corrupted=structuredClone(d);corrupted.invoices[0].government.cumulativeAmount+=100;corrupted.invoices[0].government.remaining-=100;corrupted.invoices[0].government.rows[0].cumulativeAmount+=100;assert.equal(validateBilling(corrupted),false);
});
test('chronological history includes historical amounts once and separates changed rate tiers',()=>{
  const d=data();sheet(d,'july','2026-07-01',10,10000);
  const old=governmentInvoice(d,input('2026-07',{number:'C&C-TEST025'}),'old');old.sentDate='2026-07-31';
  sheet(d,'august','2026-08-01',20);
  const current=governmentInvoice(d,input(),'current');
  assert.equal(current.number,'C&C-TEST030');assert.equal(current.government.cumulativeHours,30);assert.equal(current.government.cumulativeAmount,390000);
  assert.equal(current.government.rows.length,2);assert.equal(current.government.rows.find(r=>r.rate===10000).hours,0);assert(validBackup(d));
  assert.throws(()=>governmentInvoice(d,input('2026-09'),'later'),/Mark the previous/);
  current.sentDate='2026-08-31';assert.throws(()=>governmentInvoice(d,input('2026-06'),'earlier'),/oldest first/);
  assert.throws(()=>governmentInvoice(d,input(),'duplicate'),/already has an invoice/);
});
test('unapproved time, performance dates, funding and category assignments are enforced',()=>{
  let d=data();sheet(d,'s','2026-08-01',10);d.sheets[0].status='submitted';d.sheets[0].rows[0].status='submitted';assert.throws(()=>governmentInvoice(d,input(),'x'),/Approve all/);
  d=data();sheet(d,'s','2026-08-01',10);d.contracts[0].billing.taskOrders[0].funding=1;assert.throws(()=>governmentInvoice(d,input(),'x'),/funding/);
  d=data();d.contracts[0].billing.assignments=[];assert.throws(()=>rowTerms(d.contracts[0],'person',{taskOrderId:'order',hours:{}}),/labor category/);
  d=data();assert.throws(()=>rowTerms(d.contracts[0],'person',{taskOrderId:'order',hours:{'2025-01-01':1}}),/performance/);
  assert.equal(monthEnd('2028-02'),'2028-02-29');d.contracts[0].billing.nextNumber=0;assert.equal(validateBilling(d),false);
});

async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'timekeeper-gov-'));const server=createApp({dataDir:directory,secureCookies:false,allowedOrigin:null,allowPublicRegistration:true,authAttemptLimit:200});server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;t.after(async()=>{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true})});const request=async(path,cookie,body,method=body?'POST':'GET')=>{const response=await fetch(origin+path,{method,headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]}};const password='government integration password';const owner=await request('/api/auth/register',null,{name:'Owner',email:'owner@example.test',password});return{directory,request,owner,password};}
test('server uses locked category rates, rejects tampering and scopes invoices to admins',async t=>{
  const f=await fixture(t),doc=(await f.request('/api/workspace',f.owner.cookie)).body,d=data(),employeeId=doc.data.employees[0].id;
  d.employees[0]={...doc.data.employees[0],contracts:['contract']};d.contracts[0].billing.assignments[0].employeeId=employeeId;
  sheet(d,'s','2026-08-01',10);d.sheets[0].employeeId=employeeId;d.sheets[0].rows[0].status='draft';d.sheets[0].status='draft';
  assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:d,revision:doc.revision},'PUT')).status,200);
  let current=(await f.request('/api/workspace',f.owner.cookie)).body;current.data.sheets[0].status='submitted';current.data.sheets[0].rows[0].status='submitted';current.data.sheets[0].rows[0].rate=1;
  assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:current.data,revision:current.revision},'PUT')).status,200);
  current=(await f.request('/api/workspace',f.owner.cookie)).body;assert.equal(current.data.sheets[0].rows[0].rate,14500);current.data.sheets[0].status='approved';current.data.sheets[0].rows[0].status='approved';
  assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:current.data,revision:current.revision},'PUT')).status,200);
  current=(await f.request('/api/workspace',f.owner.cookie)).body;
  const created=await f.request('/api/invoices/government',f.owner.cookie,{...input(),revision:current.revision,government:{remaining:999999}});assert.equal(created.status,200);
  current=(await f.request('/api/workspace',f.owner.cookie)).body;assert.equal(current.data.invoices[0].government.cumulativeAmount,145000);
  const changed=structuredClone(current);changed.data.invoices[0].government.signerName='Forged signer';
  assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:changed.data,revision:changed.revision},'PUT')).status,409);
  assert.equal((await f.request('/api/invoices/government',f.owner.cookie,{...input(),revision:current.revision-1})).status,409);
  current.data.invoices[0].sentDate='2026-08-31';assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:current.data,revision:current.revision},'PUT')).status,200);
  const removal=(await f.request('/api/workspace',f.owner.cookie)).body;removal.data.invoices=[];assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:removal.data,revision:removal.revision},'PUT')).status,409);
  const invitation=await f.request('/api/invitations',f.owner.cookie,{email:'worker@example.test',role:'employee'});
  const worker=await f.request('/api/auth/register',null,{email:'worker@example.test',name:'Worker',password:f.password,inviteToken:invitation.body.token});
  assert.equal((await f.request('/api/invoices/government',worker.cookie,{...input(),revision:current.revision})).status,403);
  const assign=(await f.request('/api/workspace',f.owner.cookie)).body;
  const workerEmployeeId=assign.data.employees.find(e=>e.email==='worker@example.test').id;
  assign.data.employees.find(e=>e.id===workerEmployeeId).contracts=['contract'];
  assign.data.contracts[0].billing.assignments.push({employeeId:workerEmployeeId,categoryId:'rte'});
  assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:assign.data,revision:assign.revision},'PUT')).status,200);
  const privateView=(await f.request('/api/workspace',worker.cookie)).body;
  assert.equal(privateView.data.contracts[0].rate,undefined);assert.equal(privateView.data.contracts[0].billing,undefined);assert.equal(privateView.data.contracts[0].taskOrders.length,2);
  const submitted={id:'worker-sheet',employeeId:workerEmployeeId,start:'2026-09-01',status:'submitted',rows:[{id:'worker-row',contractId:'contract',taskOrderId:'order',laborCategory:'Forged category',status:'submitted',hours:{'2026-09-01':2},note:''}]};
  assert.equal((await f.request('/api/employee/timesheets',worker.cookie,{sheets:[submitted],revision:privateView.revision},'PUT')).status,200);
  const locked=(await f.request('/api/workspace',f.owner.cookie)).body.data.sheets.find(s=>s.id==='worker-sheet').rows[0];assert.equal(locked.rate,14500);assert.equal(locked.laborCategory,'RTE II');
assert.equal(privateView.data.invoices.length,0);assert(!JSON.stringify(privateView).includes('10000000'));
  const restoreDoc=(await f.request('/api/workspace',f.owner.cookie)).body;
  assert.equal((await f.request('/api/workspace/import',worker.cookie,{data:restoreDoc.data,revision:restoreDoc.revision})).status,403);
  assert.equal((await f.request('/api/workspace/import',f.owner.cookie,{data:restoreDoc.data,revision:restoreDoc.revision})).status,200);
  const db=openDatabase(f.directory),key=randomBytes(32),archive=await createArchive(db,join(f.directory,'archives'),key);db.close();const restored=join(f.directory,'restored');await restoreArchive(archive.path,key,restored);
  const recovered=openDatabase(restored);assert.equal(JSON.parse(recovered.prepare('SELECT data FROM workspace_documents').get().data).invoices[0].number,'C&C-TEST030');recovered.close();
});

test('multiple employees/categories and task orders keep distinct rates and funding totals',()=>{
  const d=data(),b=d.contracts[0].billing;
  d.employees.push({id:'second',name:'Second employee',email:'second@example.test',active:true,contracts:['contract']});
  b.categories.push({id:'analyst',name:'Analyst',rate:10000});b.assignments.push({employeeId:'second',categoryId:'analyst'});
  sheet(d,'owner-time','2026-08-01',8);sheet(d,'second-time','2026-08-01',4,10000);
  Object.assign(d.sheets[1],{employeeId:'second'});Object.assign(d.sheets[1].rows[0],{categoryId:'analyst',laborCategory:'Analyst'});
  const invoice=governmentInvoice(d,input(),'first-order-invoice');assert.equal(invoice.lines.length,2);assert.equal(invoice.government.cumulativeAmount,156000);
  d.sheets[0].rows.push({id:'other-order-row',contractId:'contract',status:'approved',note:'',hours:{'2026-08-01':1},rate:14500,categoryId:'rte',laborCategory:'RTE II',taskOrderId:'other-order'});
  const other=governmentInvoice(d,input('2026-08',{taskOrderId:'other-order'}),'second-order-invoice');
  assert.equal(other.government.cumulativeAmount,14500);assert.equal(other.government.funding,1000000);assert.equal(other.number,'C&C-TEST031');assert(validBackup(d));
});

test('future-dated invoices can record an actual earlier send date, but not a future send date',()=>{
  const d=data();sheet(d,'aug','2026-08-01',8);
  const invoice=governmentInvoice(d,input('2026-08',{issued:'2099-11-01',due:'2099-12-01'}),'future');
  invoice.sentDate='2026-10-28';assert.equal(validBackup(d),true);
  invoice.sentDate='2099-11-01';assert.equal(validBackup(d),false);
  invoice.sentDate='invalid';assert.equal(validBackup(d),false);
});

test('voiding government invoices preserves snapshots and allows replacement without double counting', async()=>{
  const {voidBlockReason}=await import('../public/billing.js');
  const d=data();sheet(d,'july','2026-07-01',8);const july=governmentInvoice(d,input('2026-07'),'july-invoice');july.sentDate='2026-07-31';
  sheet(d,'aug','2026-08-01',4);const aug=governmentInvoice(d,input('2026-08'),'aug-invoice');aug.sentDate='2026-08-31';
  assert.match(voidBlockReason(d,july),/newer/);assert.equal(voidBlockReason(d,aug),'');
  aug.voided={date:'2026-11-01',reason:'Incorrect invoice'};assert(validBackup(d));
  const replacement=governmentInvoice(d,input('2026-08'),'replacement');
  assert.equal(replacement.government.cumulativeHours,12);assert.equal(replacement.lines[0].hours,4);assert(validBackup(d));
  const frozen=structuredClone(aug);d.sheets.find(s=>s.id==='aug').rows[0].note='Corrected work note';assert.deepEqual(aug,frozen);
});

test('voided invoice numbers can be explicitly reused while active numbers remain unique',()=>{
 const d=data();sheet(d,'may','2026-05-01',8);
 const original=governmentInvoice(d,input('2026-05',{number:'C&C-CSS026'}),'original');original.sentDate='2026-06-01';original.voided={date:'2026-11-01',reason:'Correct historical entry'};
 const frozen=structuredClone(original);
 const replacement=governmentInvoice(d,input('2026-05',{number:original.number}),'replacement');
 assert.equal(replacement.number,'C&C-CSS026');assert.notEqual(replacement.id,original.id);assert.deepEqual(original,frozen);assert.equal(replacement.government.cumulativeHours,8);assert(validBackup(d));
 // Validation must accept either record order, including export/import ordering.
 d.invoices.reverse();assert(validBackup(d));
 replacement.sentDate='2026-06-01';sheet(d,'june','2026-06-01',4);
 assert.throws(()=>governmentInvoice(d,input('2026-06',{number:original.number}),'duplicate'),/another active invoice/);
 const june=governmentInvoice(d,input('2026-06'),'june');assert.equal(june.government.cumulativeHours,12);
 june.number=replacement.number;assert.equal(validBackup(d),false);
});

test('month-order errors identify the active invoice and ignore voided history',()=>{
 const d=data();sheet(d,'may','2026-05-01',8);
 const may=governmentInvoice(d,input('2026-05',{number:'C&C-CSS026'}),'may');may.sentDate='2026-06-01';
 assert.throws(()=>governmentInvoice(d,input('2026-03'),'march'),/C&C-CSS026 \(2026-05\).*selected billing month/);
});

test('API creates same-number replacements and retains the original voided invoice',async t=>{
 const f=await fixture(t),doc=(await f.request('/api/workspace',f.owner.cookie)).body,d=data();
 const employee=doc.data.employees[0];d.employees[0]={...employee,contracts:['contract']};d.contracts[0].billing.assignments[0].employeeId=employee.id;
 sheet(d,'may','2026-05-01',8);d.sheets[0].employeeId=employee.id;
 assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:d,revision:doc.revision},'PUT')).status,200);
 let current=(await f.request('/api/workspace',f.owner.cookie)).body;
 const create=revision=>f.request('/api/invoices/government',f.owner.cookie,{...input('2026-05',{number:'C&C-CSS026'}),revision});
 assert.equal((await create(current.revision)).status,200);
 current=(await f.request('/api/workspace',f.owner.cookie)).body;current.data.invoices[0].sentDate='2026-06-01';
 assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:current.data,revision:current.revision},'PUT')).status,200);
 current=(await f.request('/api/workspace',f.owner.cookie)).body;current.data.invoices[0].voided={date:'2026-11-01',reason:'Correct historical entry'};
 assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:current.data,revision:current.revision},'PUT')).status,200);
 current=(await f.request('/api/workspace',f.owner.cookie)).body;const original=structuredClone(current.data.invoices[0]);
 assert.equal((await create(current.revision)).status,200);
 current=(await f.request('/api/workspace',f.owner.cookie)).body;
 assert.equal(current.data.invoices.length,2);assert.deepEqual(current.data.invoices[0],original);assert.equal(current.data.invoices[1].number,original.number);assert.notEqual(current.data.invoices[1].id,original.id);assert(validBackup(current.data));
 current.data.invoices[0].voided.reason='Changed history';
 assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:current.data,revision:current.revision},'PUT')).status,409);
});

test('invoice creation ignores unrelated saves but checks the billing data shown to the user',async t=>{
 const f=await fixture(t),doc=(await f.request('/api/workspace',f.owner.cookie)).body,d=data();
 const employee=doc.data.employees[0];d.employees[0]={...employee,contracts:['contract']};d.contracts[0].billing.assignments[0].employeeId=employee.id;
 sheet(d,'may','2026-05-01',8);d.sheets[0].employeeId=employee.id;
 assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:d,revision:doc.revision},'PUT')).status,200);
 const {governmentInvoiceBasis}=await import('../public/billing.js');
 const base=(await f.request('/api/workspace',f.owner.cookie)).body,request={...input('2026-05'),revision:base.revision,basis:governmentInvoiceBasis(base.data,input('2026-05'))};
 const other=structuredClone(base.data.sheets[0]);other.id='june';other.start='2026-06-01';other.rows[0].id='june-row';other.rows[0].hours={'2026-06-01':2};
 assert.equal((await f.request('/api/workspace',f.owner.cookie,{changes:[{collection:'sheets',id:other.id,before:null,after:other}]},'PATCH')).status,200);
 assert.equal((await f.request('/api/invoices/government',f.owner.cookie,request)).status,200);
 let current=(await f.request('/api/workspace',f.owner.cookie)).body;
 current.data.invoices[0].sentDate='2026-05-31';assert.equal((await f.request('/api/workspace',f.owner.cookie,{data:current.data,revision:current.revision},'PUT')).status,200);
 current=(await f.request('/api/workspace',f.owner.cookie)).body;
 const june={...input('2026-06'),revision:current.revision,basis:governmentInvoiceBasis(current.data,input('2026-06'))};
 const signers=structuredClone(current.data.settings.invoiceSigners);signers[0].name='Updated signer';
 assert.equal((await f.request('/api/workspace',f.owner.cookie,{changes:[{collection:'settings',id:'invoiceSigners',before:current.data.settings.invoiceSigners,after:signers}]},'PATCH')).status,200);
 const blocked=await f.request('/api/invoices/government',f.owner.cookie,june);assert.equal(blocked.status,409);assert.match(blocked.body.error,/billing setup/);
});

test('record-only backfill preserves issued snapshots and stays outside future cumulative billing',()=>{
  const d=data();sheet(d,'aug','2026-08-01',10);
  const august=governmentInvoice(d,input(),'august');august.sentDate='2026-08-31';
  const frozen=structuredClone(august);
  sheet(d,'july','2026-07-01',8);
  const historical=governmentInvoice(d,input('2026-07',{historicalRecord:true,number:'C&C-TEST021'}),'historical');
  assert.equal(historical.government.historicalRecord,true);
  assert.equal(historical.government.cumulativeHours,8);
  assert.deepEqual(august,frozen);assert(validBackup(d));
  assert.throws(()=>governmentInvoice(d,input('2026-07',{historicalRecord:true}),'duplicate'),/already has an invoice/);
  sheet(d,'sep','2026-09-01',2);
  const september=governmentInvoice(d,input('2026-09'),'september');
  assert.equal(september.government.cumulativeHours,12);
  assert.equal(september.government.cumulativeAmount,174000);
  assert(validBackup(d));
  const forged=structuredClone(d);delete forged.invoices[1].government.historicalRecord;
  assert.equal(validateBilling(forged),false);
  const malformed=structuredClone(d);malformed.invoices[1].government.historicalRecord='true';
  assert.equal(validateBilling(malformed),false);
});

test('record-only backfill bypasses later drafts but retains approval and source protection',()=>{
  const d=data();sheet(d,'aug','2026-08-01',10);governmentInvoice(d,input(),'august');
  sheet(d,'july','2026-07-01',8);d.sheets[1].rows[0].status='submitted';
  assert.throws(()=>governmentInvoice(d,input('2026-07',{historicalRecord:true}),'old'),/Approve all/);
  d.sheets[1].rows[0].status='approved';
  governmentInvoice(d,input('2026-07',{historicalRecord:true}),'old');assert(validBackup(d));
  assert.throws(()=>governmentInvoice(d,input('2026-06',{historicalRecord:'true'}),'bad'),/valid historical/);
});

test('staging business refresh maps government billing identities without changing amounts or snapshots',async()=>{
 const {prepareStagingRefresh}=await import('../server/staging-refresh.js');
 const d=data();sheet(d,'may','2026-05-01',8);const invoice=governmentInvoice(d,input('2026-05'),'history');invoice.sentDate='2026-05-31';
 const refreshed=prepareStagingRefresh(d,{employees:[{id:'stage-person',name:'Stage user',email:'person@example.test',active:true,contracts:[]}]},['stage-person']);
 assert.equal(refreshed.sheets[0].employeeId,'stage-person');assert.equal(refreshed.contracts[0].billing.assignments[0].employeeId,'stage-person');
 assert.equal(refreshed.invoices[0].lines[0].employeeId,'stage-person');assert.equal(refreshed.invoices[0].government.rows[0].employeeId,'stage-person');
 assert.equal(refreshed.invoices[0].government.cumulativeAmount,invoice.government.cumulativeAmount);assert.equal(refreshed.invoices[0].number,invoice.number);assert(validBackup(refreshed));assert.equal(d.employees[0].id,'person');
});
