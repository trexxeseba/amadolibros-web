const path='/panel/meli-vintage-lote',run='23413782-4900-4000-8000-000000010000';
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let state=null,feed=localStorage.getItem('vintage-bulk-feed'),running=false,busy=false,timer=null,batchStart=null;
const labels={publishing:'publicando',paused:'pausado',stock_stale:'stock vencido',auth_error:'revisar conexión',complete:'terminado',complete_with_review:'terminado con casos para revisar',pending:'pendientes',published:'publicadas',validated:'validadas',skipped_duplicate:'ya existentes',skipped_target_reached:'fuera del objetivo',review:'para revisar',uncertain:'resultado por confirmar',retry:'en espera',skipped_identity:'edición sin confirmar',skipped_category:'categoría sin confirmar',skipped_ml_requirement:'requisitos pendientes',skipped_stock_uncertain:'sin stock confirmado'};
async function request(action,args){
 const response=await fetch(action?path:path+'?format=status',{method:action?'POST':'GET',headers:action?{'Content-Type':'application/json'}:{},body:action?JSON.stringify({action,args}):undefined,credentials:'same-origin',signal:AbortSignal.timeout(120000)});
 if(response.status===401)throw Error('La sesión venció. Ingresá al panel y volvé a esta página.');
 let data;try{data=await response.json();}catch{throw Error('No se pudo confirmar el estado. Actualizá antes de continuar.');}
 if(!response.ok)throw Error(data.error??'No se pudo completar la operación.');return data;
}
function render(data){
 state=data;const count=data.published_total??5,counts=data.summary?.counts??[];
 const phase=data.run?.state==='publishing'&&!data.summary?.index?.done?'revisando publicaciones existentes':labels[data.run?.state]??'listo para cargar el Excel';
 $('state').textContent=`${count.toLocaleString('es-UY')} de 10.000 publicadas en Vintage. Estado: ${phase}.`;
 $('details').textContent=data.run?`Stock ${data.stock_fresh?'vigente':'vencido'} · Inventario revisado: ${data.summary?.index?.seen??0} publicaciones · ${counts.map(x=>`${labels[x.state]??x.state}: ${x.n}`).join(' · ')}${data.resume_at>Date.now()?' · Próximo intento: '+new Date(data.resume_at).toLocaleString('es-UY'):''}`:'';
 $('items').innerHTML=(data.recent??[]).map(j=>`<p>${esc(j.isbn)} · <a target="_blank" rel="noopener" href="https://articulo.mercadolibre.com.uy/MLU-${esc(j.item_id.replace(/^MLU/,''))}">${esc(j.item_id)}</a></p>`).join('');
 $('issues').textContent=(data.issues??[]).map(j=>`${j.isbn}: ${j.error_code??j.state}`).join(' · ')||'Sin casos pendientes de revisión.';
 $('start').disabled=busy||!feed&&!data.run;
}
async function refresh(){render(await request());}
function stop(){running=false;clearTimeout(timer);timer=null;localStorage.removeItem('vintage-bulk-running');}
async function loop(){
 if(!running||busy)return;
 busy=true;
 try{
  const before=await request();render(before);
  if(!before.run||!['publishing','complete_with_review'].includes(before.run.state)||!before.stock_fresh){stop();return;}
  if(before.resume_at>Date.now()){timer=setTimeout(loop,Math.min(60000,Math.max(1000,before.resume_at-Date.now())));return;}
  if(before.busy){timer=setTimeout(loop,15000);return;}
  const after=await request('tick',{run_id:run});render(after);
  if(batchStart===null)batchStart=before.published_total;
  const batchComplete=after.published_total-batchStart>=25;
  if(batchComplete)batchStart=after.published_total;
  if(['complete','stock_stale','auth_error','paused'].includes(after.run?.state)){stop();return;}
  timer=setTimeout(loop,batchComplete?60000:after.summary?.index?.done?5000:1000);
 }catch(error){stop();$('state').textContent=error.message+' El avance quedó guardado. No repitas la aprobación.';}
 finally{busy=false;$('start').disabled=busy||!feed&&!state?.run;}
}
async function parse(file){
 if(!file||!file.name.toLowerCase().endsWith('.xlsx')||file.size>64*1024*1024)throw Error('Elegí el Excel de stock de SBS, de hasta 64 MB.');
 const buffer=await file.arrayBuffer(),worker=new Worker('/assets/meli-vintage-stock-worker.js',{type:'module'});
 return new Promise((resolve,reject)=>{const end=()=>{clearTimeout(timeout);worker.terminate();},timeout=setTimeout(()=>{end();reject(Error('El Excel tardó demasiado en leerse.'));},120000);
 worker.onmessage=({data})=>{end();data.ok?resolve(data.result):reject(Error(data.error));};worker.onerror=()=>{end();reject(Error('No se pudo leer el Excel.'));};worker.postMessage({buffer,full:true},[buffer]);});
}
$('load').addEventListener('click',async()=>{
 if(busy)return;stop();busy=true;$('load').disabled=true;
 try{
  $('upload').textContent='Leyendo stock, precios, peso e ISBN del Excel…';
  const input=await parse($('stock').files[0]),stamp=Date.parse(input.source_date);
  if(!Number.isFinite(stamp)||stamp>Date.now()+300000||Date.now()-stamp>86400000)throw Error('La fecha interna del Excel está vencida. Necesita stock de menos de 24 horas.');
  if(input.rows.length<10000)throw Error('Este archivo tiene menos de 10.000 ISBN con stock y datos válidos.');
  const hashBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode('vintage-bulk-positive-v1:'+input.source_sha256)),hash=[...new Uint8Array(hashBytes)].map(x=>x.toString(16).padStart(2,'0')).join('');
  feed=`${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
  const begin=await request('begin',{feed_id:feed,source_date:input.source_date,source_sha256:hash,expected_rows:input.rows.length});
  if(begin.state!=='ready'){
   for(let offset=0;offset<input.rows.length;offset+=200){await request('import',{feed_id:feed,rows:input.rows.slice(offset,offset+200)});$('upload').textContent=`Importando stock privado de Vintage: ${Math.min(offset+200,input.rows.length)} / ${input.rows.length} ISBN. Todavía no publica.`;}
   await request('commit',{feed_id:feed});
  }
  localStorage.setItem('vintage-bulk-feed',feed);
  $('upload').textContent=`Stock cargado: ${input.rows.length} ISBN disponibles, fecha ${new Date(stamp).toLocaleString('es-UY')}. ${input.rejected??0} filas excluidas por datos insuficientes y ${input.duplicate_isbns??0} ISBN repetidos excluidos. Listo para iniciar las tandas.`;
  await refresh();
 }catch(error){$('upload').textContent=error.message;}
 finally{busy=false;$('load').disabled=false;$('start').disabled=!feed&&!state?.run;}
});
$('start').addEventListener('click',async()=>{
 if(busy)return;stop();busy=true;$('start').disabled=true;
 try{await refresh();render(await request('start',{feed_id:feed??state.summary.feed_id,policy_hash:state.summary?.policy_hash??state.policy_hash}));running=true;localStorage.setItem('vintage-bulk-running','true');batchStart=state.published_total;}
 catch(error){$('state').textContent=error.message;}
 finally{busy=false;}
 if(running)void loop();
});
$('pause').addEventListener('click',async()=>{stop();try{render(await request('pause',{run_id:run}));}catch(error){$('state').textContent=error.message;}});
$('refresh').addEventListener('click',()=>refresh().catch(error=>{$('state').textContent=error.message;}));
refresh().then(()=>{if(localStorage.getItem('vintage-bulk-running')==='true'&&state.run){running=true;void loop();}}).catch(error=>{$('state').textContent=error.message;});
