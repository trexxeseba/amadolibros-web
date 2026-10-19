import fs from 'node:fs/promises';
import path from 'node:path';

const minuteOf=time=>new Date(Math.floor(time/60000)*60000).toISOString();
const counter=()=>({requests:0,cache_hits:0,responses_429:0,transport_failures:0,duration_ms:0});
function add(row,event){
 if(event.kind==='cache_hit')row.cache_hits++;
 else{row.requests++;row.responses_429+=Number(event.status===429);row.transport_failures+=Number(event.status===0);row.duration_ms+=event.duration_ms;}
}
function retryHeader(value){
 if(value===null||value===undefined)return null;
 if(/^\d{1,7}(?:\.\d{1,3})?$/.test(value))return value;
 const time=Date.parse(value);return Number.isFinite(time)?new Date(time).toUTCString():null;
}
// Book keys exist only in memory for attribution. No key, SKU, ISBN, id, token or URL is written.
export function createRequestTelemetry(directory,{now=Date.now,appendFile=fs.appendFile}={}){
 const minutes=new Map(),books=new Map(),rateLines=[];let activeBook=null,failed=false;
 function book(key){if(!books.has(key))books.set(key,{...counter(),endpoints:new Map(),phases:new Set(),creates:0,outcome:'observed'});return books.get(key);}
 function record(event){
  const minute=minuteOf(event.at),key=JSON.stringify([minute,event.method,event.endpoint]);
  if(!minutes.has(key))minutes.set(key,{kind:'minute_delta',minute,method:event.method,endpoint:event.endpoint,...counter()});
  add(minutes.get(key),event);
  if(activeBook!==null){
   const row=book(activeBook),route=event.method+' '+event.endpoint;add(row,event);
   if(!row.endpoints.has(route))row.endpoints.set(route,counter());add(row.endpoints.get(route),event);
   if(event.kind==='request'&&route==='POST /items')row.creates++;
  }
  if(event.kind==='request'&&event.status===429)rateLines.push({at:new Date(event.at).toISOString(),method:event.method,endpoint:event.endpoint,retry_after:retryHeader(event.retry_after)});
 }
 async function withBook(key,phase,fn){
  if(!key)return fn();
  const previous=activeBook;activeBook=key;book(key).phases.add(phase);
  try{return await fn();}finally{activeBook=previous;}
 }
 function mark(key,outcome){if(key)book(key).outcome=outcome;}
 async function flush(){
  // Independent files: a partial write cannot turn an accepted POST into a book failure.
  if(rateLines.length){try{await appendFile(path.join(directory,'rate-limit-events.jsonl'),rateLines.map(x=>JSON.stringify(x)).join('\n')+'\n');rateLines.length=0;}catch{failed=true;}}
  if(!minutes.size&&!books.size)return !failed;
  const at=new Date(now()).toISOString(),rows=[...minutes.values(),...[...books.values()].map(row=>({kind:'book_delta',at,requests:row.requests,cache_hits:row.cache_hits,responses_429:row.responses_429,transport_failures:row.transport_failures,duration_ms:row.duration_ms,creates:row.creates,outcome:row.outcome,phases:[...row.phases],endpoints:Object.fromEntries(row.endpoints)}))];
  try{await appendFile(path.join(directory,'request-counts.jsonl'),rows.map(x=>JSON.stringify(x)).join('\n')+'\n');minutes.clear();books.clear();}catch{failed=true;}
  return !failed;
 }
 return {record,withBook,mark,flush};
}

export function summarizeRequestRows(rows){
 const minutes=rows.filter(r=>r.kind==='minute_delta'),books=rows.filter(r=>r.kind==='book_delta'),byEndpoint={},byMinute={};
 for(const row of minutes){const key=row.method+' '+row.endpoint;byEndpoint[key]??=counter();byMinute[row.minute]??=counter();for(const field of Object.keys(counter())){byEndpoint[key][field]+=Number(row[field])||0;byMinute[row.minute][field]+=Number(row[field])||0;}}
 const creationBooks=books.filter(r=>r.creates>0),total=minutes.reduce((n,r)=>n+r.requests,0),newBookCalls=creationBooks.map(r=>r.requests).sort((a,b)=>a-b);
 return {network_requests:total,cache_hits:minutes.reduce((n,r)=>n+r.cache_hits,0),responses_429:minutes.reduce((n,r)=>n+r.responses_429,0),creation_observations:creationBooks.length,create_requests:creationBooks.reduce((n,r)=>n+r.creates,0),calls_during_new_book_attempt:{mean:newBookCalls.length?newBookCalls.reduce((a,b)=>a+b,0)/newBookCalls.length:null,min:newBookCalls[0]??null,max:newBookCalls.at(-1)??null},peak_requests_per_minute:Math.max(0,...Object.values(byMinute).map(x=>x.requests)),by_endpoint:byEndpoint,by_minute:byMinute,note:'Counts are deltas, not snapshots. New-book observations include that tick; later reconciliations and startup inventory are included in total network_requests, not in the new-book mean.'};
}
