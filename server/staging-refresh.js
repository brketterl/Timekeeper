import { randomUUID } from 'node:crypto';
import { validBackup } from './validation.js';
const fail=message=>Object.assign(Error(message),{status:400});
// Workspace JSON only: authentication tables and service credentials never enter this path.
export function prepareStagingRefresh(source,current,linkedEmployeeIds){
 const keys=['version','demo','settings','employees','contracts','sheets','invoices'];
 if(!source||Object.keys(source).some(key=>!keys.includes(key))||source.version!==2||!validBackup(source))throw fail('Choose a valid version-2 workspace JSON export from production, not a database recovery archive.');
 const data=structuredClone(source);data.demo=false;
 const linked=current.employees.filter(e=>linkedEmployeeIds.includes(e.id)),map=new Map();
 for(const employee of data.employees){
  const matches=linked.filter(e=>employee.email&&e.email.toLowerCase()===employee.email.toLowerCase());
  if(matches.length>1)throw fail('Multiple staging accounts match an imported employee email. Resolve the duplicate staging identities first.');
  const match=matches[0];
  if(match&&[...map.values()].includes(match.id))throw fail('Multiple production employees match a staging account. Resolve the duplicate employee emails first.');
  const next=match?.id||randomUUID();map.set(employee.id,next);employee.id=next;
  if(match){employee.email=match.email;employee.active=true}
 }
 for(const sheet of data.sheets)sheet.employeeId=map.get(sheet.employeeId);
 for(const contract of data.contracts)for(const assignment of contract.billing?.assignments||[])assignment.employeeId=map.get(assignment.employeeId);
 for(const invoice of data.invoices){
  for(const line of invoice.lines)if(line.employeeId)line.employeeId=map.get(line.employeeId);
  for(const row of invoice.government?.rows||[])row.employeeId=map.get(row.employeeId);
 }
 for(const employee of linked)if(!data.employees.some(e=>e.id===employee.id))data.employees.push({...structuredClone(employee),active:true,contracts:[]});
 if(!validBackup(data))throw fail('The imported workspace could not be mapped safely to staging accounts. Nothing changed.');
 return data;
}
