import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {createApp} from '../server/index.js';
import {prepareStagingRefresh} from '../server/staging-refresh.js';
const source=()=>({version:2,demo:false,settings:{business:'Production business',email:'billing@example.test',address:'',paymentNote:'',schedule:'semimonthly'},employees:[{id:'production-person',name:'Real employee',email:'owner@example.test',active:true,contracts:['contract']}],contracts:[{id:'contract',name:'Real contract',client:'Real client',email:'client@example.test',address:'',rate:10000,budget:0,active:true}],sheets:[{id:'sheet',employeeId:'production-person',start:'2026-05-01',status:'approved',rows:[{id:'row',contractId:'contract',status:'approved',rate:10000,note:'',hours:{'2026-05-01':2}}]}],invoices:[{id:'invoice',number:'HISTORICAL-1',contractId:'contract',client:'Real client',contract:'Real contract',email:'client@example.test',address:'',business:{business:'Production business',email:'billing@example.test',address:''},issued:'2026-05-31',due:'2026-06-30',sentDate:'2026-05-31',lines:[{sources:[{sheetId:'sheet',rowId:'row'}],description:'Work',employee:'Real employee',employeeId:'production-person',start:'2026-05-01',end:'2026-05-15',hours:2,rate:10000,amount:20000}],payments:[],note:''}]});
async function fixture(t,enabled=true){
 const directory=await mkdtemp(join(tmpdir(),'staging-refresh-test-'));
 const server=createApp({dataDir:directory,secureCookies:false,allowedOrigin:null,allowPublicRegistration:true,stagingRefresh:enabled});server.listen(0,'127.0.0.1');await once(server,'listening');
 const origin=`http://127.0.0.1:${server.address().port}`;
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true})});
 const request=async(path,cookie,data)=>{const response=await fetch(origin+path,{method:data?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},...(data?{body:JSON.stringify(data)}:{})});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]}};
 const login={name:'Stage owner',email:'owner@example.test',password:'separate staging password'};
 const owner=await request('/api/auth/register',null,login);return{directory,request,owner,login};
}
test('staging refresh maps business references and preserves separate linked test identities',()=>{
 const input=source(),frozen=structuredClone(input),current={employees:[{id:'stage-owner',name:'Test owner',email:'owner@example.test',active:true,contracts:[]},{id:'stage-partner',name:'Test partner',email:'partner@example.test',active:true,contracts:[]}]};
 const data=prepareStagingRefresh(input,current,['stage-owner','stage-partner']);assert.deepEqual(input,frozen);
 assert.equal(data.sheets[0].employeeId,'stage-owner');assert.equal(data.invoices[0].lines[0].employeeId,'stage-owner');assert.equal(data.invoices[0].lines[0].employee,'Real employee');assert.equal(data.invoices[0].number,'HISTORICAL-1');assert.equal(data.invoices[0].lines[0].sources[0].sheetId,'sheet');
 assert(data.employees.some(e=>e.id==='stage-partner'&&e.active));
 assert.throws(()=>prepareStagingRefresh({...input,users:[{password_hash:'must never import'}]},current,[]),/workspace JSON/);
 const duplicate=structuredClone(input);duplicate.employees.push({...duplicate.employees[0],id:'duplicate'});assert.throws(()=>prepareStagingRefresh(duplicate,current,['stage-owner']),/Multiple production employees/);
});
test('refresh is disabled by default and refuses active outbound integrations',async t=>{
 const f=await fixture(t,false);assert.equal((await f.request('/api/staging-refresh/status',f.owner.cookie)).body.enabled,false);
 assert.equal((await f.request('/api/staging-refresh',f.owner.cookie,{data:source(),revision:0})).status,404);
 assert.throws(()=>createApp({stagingRefresh:true,secureCookies:false,allowedOrigin:null,accountEmailConfig:{origin:'http://localhost',send:async()=>{}}}),/Disable outgoing/);
});
test('refresh backs up staging first, preserves logins, and rejects stale refreshes',async t=>{
 const f=await fixture(t),before=(await f.request('/api/workspace',f.owner.cookie)).body;
 const result=await f.request('/api/staging-refresh',f.owner.cookie,{data:source(),revision:before.revision});assert.equal(result.status,200);
 const backup=JSON.parse(await readFile(join(f.directory,'staging-refresh-backups',result.body.backup),'utf8'));assert.deepEqual(backup,before.data);
 const after=(await f.request('/api/workspace',f.owner.cookie)).body;assert.equal(after.data.settings.business,'Production business');assert.equal(after.employeeId,before.employeeId);assert.equal(after.data.sheets[0].employeeId,before.employeeId);
 assert.equal((await f.request('/api/auth/login',null,f.login)).status,200);
 assert.equal((await f.request('/api/staging-refresh',f.owner.cookie,{data:source(),revision:before.revision})).status,409);
 assert.equal((await readdir(join(f.directory,'staging-refresh-backups'))).length,1);
});
test('a failed staging backup prevents any data replacement',async t=>{
 const f=await fixture(t),before=(await f.request('/api/workspace',f.owner.cookie)).body;
 await writeFile(join(f.directory,'staging-refresh-backups'),'cannot create a backup directory');
 assert.equal((await f.request('/api/staging-refresh',f.owner.cookie,{data:source(),revision:before.revision})).status,500);
 assert.deepEqual((await f.request('/api/workspace',f.owner.cookie)).body,before);
});
