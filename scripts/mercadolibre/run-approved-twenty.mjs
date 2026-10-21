import fs from 'node:fs/promises';
import {APPROVED} from './approved-twenty-manifest.mjs';
const dir='artifacts/approved-twenty',applying=process.env.PILOT_APPLY==='true';
await fs.mkdir(dir,{recursive:true});
const summary={mode:applying?'apply':'report',authorized_items:APPROVED.length,authorized_attributes:APPROVED.reduce((n,p)=>n+p.changes.length,0),eligible:[],blocked:[],verified:[],already_matches:[],stopped:null};
const attempted=new Set();
async function call(action,id){
 const res=await fetch(process.env.PILOT_URL+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+process.env.PILOT_SECRET,'Content-Type':'application/json'},body:JSON.stringify({id}),signal:AbortSignal.timeout(90000)});
 const data=await res.json();await fs.writeFile(`${dir}/${id}-${action}.json`,JSON.stringify({http_status:res.status,...data},null,2)+'\n');
 if(!res.ok)throw Error(data.error||'unexpected_http_'+res.status);return data;
}
try{
 // Reportar todos antes de escribir. Un bloqueo preflight deja ese ítem afuera.
 for(const p of APPROVED){
  try{const r=await call('report',p.id);if(r.state==='eligible')summary.eligible.push(p.id);else if(r.state==='already_matches')summary.already_matches.push(p.id);else throw Error('unexpected_report_state');}
  catch(e){summary.blocked.push({id:p.id,reason:e.message});}
 }
 if(!summary.eligible.length&&!summary.already_matches.length)throw Error('no_eligible_items');
 if(applying){
  for(const id of summary.eligible){
   attempted.add(id);
   try{
    const r=await call('apply',id);
    if(r.state==='verified')summary.verified.push(id);
    else if(r.state==='already_matches')summary.already_matches.push(id);
    else throw Error('receipt_requires_review');
   }catch(e){
    // Cualquier recibo significa que pudo comenzar un PUT. No continuar.
    const r=await call('receipt',id);
    if(r.receipt)throw Error('uncertain_operation_'+id);
    summary.blocked.push({id,reason:e.message});
   }
  }
  await new Promise(r=>setTimeout(r,30000));
  for(const id of summary.verified){const r=await call('verify',id);if(r.state!=='verified')throw Error('final_verification_failed');}
 }
}catch(e){summary.stopped=e.message;process.exitCode=1;}
finally{
 if(applying)for(const id of attempted){
  try{const r=await call('receipt',id);if(summary.verified.includes(id)&&(!r.receipt?.before_json||r.receipt.state!=='verified'))throw Error('verified_receipt_incomplete');}
  catch(e){summary.stopped=summary.stopped||'receipt_export_failed_'+id;process.exitCode=1;}
 }
 await fs.writeFile(`${dir}/summary.json`,JSON.stringify({...summary,completed_at:new Date().toISOString()},null,2)+'\n');
 console.log(JSON.stringify(summary));
}
