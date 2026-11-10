import { isDeepStrictEqual as equal } from 'node:util';
const fail=(status,message)=>Object.assign(new Error(message),{status});
const records=['employees','contracts','sheets','invoices'];
// Compare only records touched by this request, inside the caller's write transaction.
export function applyChanges(current,changes,{employee=false}={}){
 if(!Array.isArray(changes)||changes.length>10000)throw fail(400,'Invalid record changes.');
 const data=structuredClone(current),seen=new Set();
 for(const change of changes){
  if(!change||Object.keys(change).some(k=>!['collection','id','before','after'].includes(k))||!Object.hasOwn(change,'before')||!Object.hasOwn(change,'after'))throw fail(400,'Invalid record change.');
  const {collection,id,before,after}=change;
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(id)||['__proto__','constructor','prototype'].includes(id)||!(employee?collection==='sheets':[...records,'settings','metadata'].includes(collection)))throw fail(403,'This record cannot be changed.');
  const key=collection+'/'+id;if(seen.has(key))throw fail(400,'Duplicate record change.');seen.add(key);
  let value,index;
  if(records.includes(collection)){
   index=data[collection].findIndex(record=>record.id===id);value=index<0?null:data[collection][index];
   if(after!==null&&(!after||typeof after!=='object'||Array.isArray(after)||after.id!==id))throw fail(400,'Invalid record change.');
   if(collection==='sheets'&&after&&data.sheets.some(s=>s.id!==id&&s.employeeId===after.employeeId&&s.start===after.start))throw fail(409,'Someone else created this timesheet. Export your edits before reloading the latest copy.');
  }else{
   if(collection==='metadata'&&!['demo','version'].includes(id))throw fail(403,'This field cannot be changed.');
   const target=collection==='settings'?data.settings:data;value=Object.hasOwn(target,id)?target[id]:null;
  }
  if(!equal(value,before))throw fail(409,`Someone else changed this ${collection==='sheets'?'timesheet':collection==='settings'?'setting':collection==='metadata'?'workspace field':collection.slice(0,-1)}. Your edits have been kept in this browser. Export them before reloading the latest copy.`);
  if(records.includes(collection)){
   if(after===null){if(index>=0)data[collection].splice(index,1)}
   else if(index<0)data[collection].push(structuredClone(after));else data[collection][index]=structuredClone(after);
  }else{
   const target=collection==='settings'?data.settings:data;
   if(after===null)delete target[id];else target[id]=structuredClone(after);
  }
 }
 return data;
}
