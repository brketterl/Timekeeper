import { validateBilling } from '../public/billing.js';
const dateObj=d=>new Date(d+'T12:00:00');
const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today=()=>iso(new Date());
const addDays=(d,n)=>{const x=dateObj(d);x.setDate(x.getDate()+n);return iso(x)};
const dayDiff=(a,b)=>Math.round((Date.UTC(...a.split('-').map((n,i)=>i===1?+n-1:+n))-Date.UTC(...b.split('-').map((n,i)=>i===1?+n-1:+n)))/86400000);
const periodFor=d=>d.slice(0,8)+(Number(d.slice(8))<=15?'01':'16');
const periodEnd=d=>{const p=periodFor(d);return p.endsWith('01')?p.slice(0,8)+'15':iso(new Date(dateObj(p).getFullYear(),dateObj(p).getMonth()+1,0,12))};
const sum=a=>a.reduce((s,n)=>s+n,0);
const rowHours=r=>sum(Object.values(r.hours));
function refreshSheet(s){s.status=!s.rows.length||s.rows.some(r=>r.status==='draft')?'draft':s.rows.some(r=>r.status==='submitted')?'submitted':'approved';return s}
function validBackup(x){
 const str=v=>typeof v==='string',id=v=>str(v)&&/^[a-zA-Z0-9_-]{1,100}$/.test(v),date=v=>str(v)&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&iso(dateObj(v))===v,num=v=>typeof v==='number'&&Number.isFinite(v)&&v>=0,int=v=>num(v)&&Number.isSafeInteger(v),uniq=a=>new Set(a.map(v=>v.id)).size===a.length;
 try{if(![1,2].includes(x.version)||typeof x.demo!=='boolean'||![x.employees,x.contracts,x.sheets,x.invoices].every(Array.isArray)||!x.employees.length||(x.version===1?!date(x.settings.anchor):x.settings.schedule!=='semimonthly')||!['business','email','address','paymentNote'].every(k=>str(x.settings[k])))return false;
 if(![x.employees,x.contracts,x.sheets,x.invoices].every(uniq))return false;
 if(!x.contracts.every(c=>id(c.id)&&['name','client','email','address'].every(k=>str(c[k]))&&int(c.rate)&&c.rate>0&&num(c.budget)&&typeof c.active==='boolean'))return false;
 const cs=new Set(x.contracts.map(c=>c.id)),es=new Set(x.employees.map(e=>e.id));
 if(!x.employees.every(e=>id(e.id)&&str(e.name)&&e.name.trim()&&str(e.email)&&typeof e.active==='boolean'&&Array.isArray(e.contracts)&&e.contracts.every(c=>cs.has(c))))return false;
 const keys=new Set();for(const s of x.sheets){const key=s.employeeId+'|'+s.start;if(keys.has(key))return false;keys.add(key);if(!id(s.id)||!es.has(s.employeeId)||!date(s.start)||(x.version===1?dayDiff(s.start,x.settings.anchor)%14!==0:s.start!==periodFor(s.start))||!['draft','submitted','approved'].includes(s.status)||!Array.isArray(s.rows)||!uniq(s.rows))return false;const days={};for(const r of s.rows){if(!id(r.id)||(x.version===2&&!['draft','submitted','approved'].includes(r.status))||!cs.has(r.contractId)||!int(r.rate)||!str(r.note)||!r.hours||typeof r.hours!=='object'||Array.isArray(r.hours))return false;for(const [d,h]of Object.entries(r.hours)){if(!date(d)||d<s.start||d>(x.version===1?addDays(s.start,13):periodEnd(s.start))||!num(h)||h>24||h*4%1!==0)return false;days[d]=(days[d]||0)+h;if(days[d]>24)return false}}if(x.version===2&&s.status!==refreshSheet({...s}).status)return false}
 const used=new Set(),numbers=new Set();for(const i of x.invoices){if(!id(i.id)||!(str(i.number)&&i.number.trim()&&i.number.length<=80&&!/[\r\n<>]/.test(i.number))||numbers.has(i.number)||!cs.has(i.contractId)||!['client','contract','email','address','note'].every(k=>str(i[k]))||!date(i.issued)||!date(i.due)||i.due<i.issued||(i.sentDate!==null&&(!date(i.sentDate)||i.sentDate>today()))||!['business','email','address'].every(k=>str(i.business[k]))||!Array.isArray(i.lines)||!i.lines.length||!Array.isArray(i.payments)||!uniq(i.payments))return false;numbers.add(i.number);for(const l of i.lines){
 const refs=x.version===1?[{sheetId:l.sheetId,rowId:l.rowId}]:l.sources,end=x.version===1?addDays(l.start,13):l.end;
 if(!Array.isArray(refs)||!refs.length||!str(l.description)||!str(l.employee)||!date(l.start)||!date(end)||end<l.start||!num(l.hours)||l.hours<=0||!int(l.rate)||!int(l.amount))return false;
 let sourceHours=0;for(const ref of refs){const s=x.sheets.find(s=>s.id===ref.sheetId),r=s?.rows.find(r=>r.id===ref.rowId),key=ref.sheetId+'|'+ref.rowId;if(!s||!r||(x.version===1?s.status:r.status)!=='approved'||r.contractId!==i.contractId||used.has(key)||l.rate!==r.rate||(x.version===1&&l.start!==s.start)||Object.keys(r.hours).some(d=>d<l.start||d>end))return false;sourceHours+=rowHours(r);used.add(key)}
 if(l.hours!==sourceHours||l.amount!==Math.round(l.hours*l.rate))return false;
 }if(!i.payments.every(p=>id(p.id)&&int(p.amount)&&p.amount>0&&date(p.date)&&p.date>=i.issued&&p.date<=today()&&str(p.reference))||sum(i.lines.map(l=>l.amount))<1||sum(i.payments.map(p=>p.amount))>sum(i.lines.map(l=>l.amount))||(!i.sentDate&&i.payments.length))return false}return validateBilling(x);
 }catch(e){return false}
}

export { validBackup };
