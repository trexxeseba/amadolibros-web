import fs from 'node:fs/promises';
import {APPROVED} from './approved-four-worker.mjs';
const dir='artifacts/approved-four';
const applying=process.env.PILOT_APPLY==='true';
await fs.mkdir(dir,{recursive:true});
async function call(action,id){
  const res=await fetch(process.env.PILOT_URL+'/'+action,{method:'POST',headers:{Authorization:'Bearer '+process.env.PILOT_SECRET,'Content-Type':'application/json'},body:JSON.stringify({id}),signal:AbortSignal.timeout(90000)});
  const data=await res.json();
  await fs.writeFile(`${dir}/${id}-${action}.json`,JSON.stringify({http_status:res.status,...data},null,2)+'\n');
  if(!res.ok)throw Error(`${id}: ${data.error||res.status}; no reintentar escrituras sin revisar recibos`);
  return data;
}
// Todos los reportes antes de la primera escritura; cada apply vuelve a consultar.
try{
  for(const p of APPROVED){await call('report',p.id);console.log(p.id+': preflight completo');}
  if(applying){
    for(const p of APPROVED){const r=await call('apply',p.id);console.log(p.id+': '+r.state);if(!['verified','already_matches'].includes(r.state))throw Error('Revisión del recibo requerida');}
    await new Promise(r=>setTimeout(r,30000));
    for(const p of APPROVED){const r=await call('verify',p.id);console.log(p.id+': verificación final '+r.state);}
  }
}finally{
  if(applying)for(const p of APPROVED){try{await call('receipt',p.id);}catch{console.error(p.id+': recibo no disponible; revisar resultado guardado');}}
}
