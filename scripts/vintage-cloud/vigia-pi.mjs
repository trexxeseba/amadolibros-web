// Vigía de infracciones de propiedad intelectual de Amado Vintage (después de la suspensión del
// 08/11/2026: hubo dos avisos de Mercado Libre antes y el publicador siguió como si nada).
//
// En cada corrida lee /moderations/infractions de la cuenta. Si aparece una infracción de propiedad
// intelectual que no estaba vista:
//  - deja el FRENO puesto en D1 (ml_vintage_cloud_flags, clave 'freno_pi'): el publicador no publica
//    más hasta que Seba lo libere (acción 'liberar_freno' del workflow);
//  - manda un mail de ALARMA con la publicación y el motivo.
// La primera vez toma como vistas las infracciones que ya existen (no salta por las viejas).
// Sólo lee de Mercado Libre; escribe sólo en sus tablas de D1.
import {CUENTAS} from '../../precio-ganador/src/config.mjs';
import {fuenteTokenD1} from '../../precio-ganador/src/token.mjs';
import {crearCliente} from '../../precio-ganador/src/ml.mjs';
import {sendMail} from './aviso.mjs';
import {ipRisk} from '../../worker-sync/ip-risk.js';

export const SELLER='2341378249';
export const FLAG='freno_pi';
const SEEN='ml_vintage_cloud_infractions_seen',FLAGS='ml_vintage_cloud_flags';
// Publicaciones pausadas por riesgo de propiedad intelectual (por el vigía o por la pausa masiva):
// la sincronización de stock nunca las reactiva y el publicador nunca las vuelve a dar de alta.
export const BLOCKED='ml_vintage_cloud_ip_blocked';
export async function blockedSchema(query){await query(`CREATE TABLE IF NOT EXISTS ${BLOCKED} (item_id TEXT PRIMARY KEY,isbn TEXT,motivo TEXT,at INTEGER NOT NULL)`);}
export async function blockItems(query,rows,now=Date.now()){await blockedSchema(query);for(const r of rows)await query(`INSERT INTO ${BLOCKED}(item_id,isbn,motivo,at) VALUES(?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET motivo=excluded.motivo`,[r.item_id,r.isbn??null,r.motivo??'',now]);}
export async function blockedIds(query){await blockedSchema(query);return new Set((await query(`SELECT item_id FROM ${BLOCKED}`)).map(r=>String(r.item_id)));}
export async function blockedIsbns(query){await blockedSchema(query);return new Set((await query(`SELECT isbn FROM ${BLOCKED} WHERE isbn IS NOT NULL AND isbn<>''`)).map(r=>String(r.isbn)));}

// Qué publicaciones activas se parecen a una denunciada: misma editorial, o mismo patrón del filtro
// de propiedad intelectual. Decisión de Seba (08/11/2026): ante una denuncia no se defiende, se
// pausa la denunciada y lo parecido, cuanto antes.
export function similarTo(denounced,candidates){
 const pub=String(denounced?.publisher??'').trim().toLowerCase();
 const risk=ipRisk(denounced?.title,denounced?.publisher);
 return candidates.filter(c=>c.id!==denounced.id&&c.status==='active'&&((pub&&String(c.publisher??'').trim().toLowerCase()===pub)||(risk&&ipRisk(c.title,c.publisher)===risk)));
}

// ¿Es una infracción de propiedad intelectual? Por subgrupo o por el texto del motivo.
// Infracciones que cuentan como problema real además de las de propiedad intelectual: productos prohibidos o
// denuncias confirmadas. Las de fotos, categoría, precio, duplicadas y datos de contacto son avisos de calidad:
// se anotan pero no frenan (Seba, 13/11/2026: sólo frenar ante un problema real).
export const SERIOUS_SUBGROUP=/BRAND_PROTECTION|DENYLIST|TABACO|ALIMENTOS|ARMAS|MEDICAMENTOS/i;
export const isSerious=infraction=>isIp(infraction)||SERIOUS_SUBGROUP.test(String(infraction?.filter_subgroup??''));
export function isIp(infraction){
 const sub=String(infraction?.filter_subgroup??'');
 const reason=String(infraction?.reason??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
 // PPPI1..PPPI6 son los motivos de denuncia de propiedad intelectual (PPPI6: derechos sobre imágenes).
 return /COPIAS|REPLICA|PI_|FAKE|COUNTERFEIT|INTELLECTUAL|PPPI\d?/i.test(sub)||/propiedad intelectual|falsific|no era original|originalidad|replica|copia no autorizada|derechos de autor|imagen(es)? (sin autorizacion|protegida)/.test(reason);
}

async function schema(query){
 await query(`CREATE TABLE IF NOT EXISTS ${SEEN} (id TEXT PRIMARY KEY,item_id TEXT,subgroup TEXT,ip INTEGER NOT NULL,created TEXT,seen_at INTEGER NOT NULL)`);
 await query(`CREATE TABLE IF NOT EXISTS ${FLAGS} (key TEXT PRIMARY KEY,value TEXT NOT NULL,at INTEGER NOT NULL)`);
}
export async function brakeOn(query){
 await schema(query);
 const row=(await query(`SELECT value,at FROM ${FLAGS} WHERE key=?`,[FLAG]))[0];
 return row?{...JSON.parse(row.value),at:row.at}:null;
}
export async function releaseBrake(query){await schema(query);await query(`DELETE FROM ${FLAGS} WHERE key=?`,[FLAG]);}

// Revisa las infracciones. getInfractions(offset) devuelve una página (10) de las más nuevas primero.
export async function watch({query,getInfractions,getItemTitle=async()=>null,getCases=async()=>[],react=null,send=sendMail,now=Date.now(),runUrl=null,maxPages=80}){
 await schema(query);
 // Primera corrida: se aprende lo que hay y no se avisa. Se marca con una bandera, no contando
 // filas: en una cuenta sin infracciones la primera corrida no guarda nada y la siguiente volvería
 // a creerse la primera.
 const armed=(await query(`SELECT value FROM ${FLAGS} WHERE key='vigia_armado'`))[0];
 const baseline=!armed;
 if(baseline)await query(`INSERT OR IGNORE INTO ${FLAGS}(key,value,at) VALUES('vigia_armado','1',?)`,[now]);
 const fresh=[];
 for(let page=0;page<maxPages;page++){
  const list=await getInfractions(page*10);
  if(!list.length)break;
  for(const inf of list){
   const id=String(inf.id??'');if(!id)continue;
   const seen=(await query(`SELECT id FROM ${SEEN} WHERE id=?`,[id]))[0];
   if(seen)continue;
   const ip=isSerious(inf)?1:0;
   await query(`INSERT OR IGNORE INTO ${SEEN}(id,item_id,subgroup,ip,created,seen_at) VALUES(?,?,?,?,?,?)`,[id,inf.element_id??inf.related_item_id??null,inf.filter_subgroup??null,ip,inf.date_created??null,now]);
   if(ip&&!baseline)fresh.push(inf);
  }
  // Se recorren todas las páginas (no se confía en el orden): son pocas llamadas por hora.
  if(list.length<10)break;
 }
 // Denuncias abiertas del Brand Protection Program: tienen plazo (due_date) y las responde el vendedor
 // en la publicación. Una denuncia abierta nueva frena igual que una infracción.
 let cases=[];try{cases=await getCases();}catch{cases=null;}
 // La respuesta de Mercado Libre puede traer un bloque de paginación ({total,offset,limit}) en lugar de casos: no es un caso.
 const openCases=(cases??[]).filter(c=>(c?.id??c?.case_id)!==undefined&&!/^(REJECTED|DISCARDED|DOCUMENTATION_APPROVED|MEMBER_NOT_RESPOND)|closed|finished|resolved/i.test(String(c?.current_status??c?.status??'')));
 for(const c of openCases){
  const id='case:'+String(c.id??c.case_id??'');if(id==='case:')continue;
  const seen=(await query(`SELECT id FROM ${SEEN} WHERE id=?`,[id]))[0];
  if(seen)continue;
  await query(`INSERT OR IGNORE INTO ${SEEN}(id,item_id,subgroup,ip,created,seen_at) VALUES(?,?,?,?,?,?)`,[id,c.item_id??c.element_id??null,'BPP_'+String(c.current_status??c.status??''),1,c.date_created??c.due_date??null,now]);
  // Una denuncia vieja que recién ahora se alcanza a leer se anota sin alarma: sólo reaccionan las de los últimos 3 días.
  const edad=now-Date.parse(c.date_created??'');
  if(!baseline&&!(edad>3*86400000))fresh.push({id,element_id:c.item_id??c.element_id??null,filter_subgroup:'DENUNCIA_BPP',reason:`Denuncia del Brand Protection Program (${c.current_status??c.status??''}). Vence: ${c.due_date??'sin dato'}.`,date_created:c.date_created??null});
 }
 if(!fresh.length)return {baseline,nuevas_pi:0,denuncias_abiertas:cases===null?null:openCases.length,freno:await brakeOn(query)};
 const items=[];
 for(const inf of fresh){const item=inf.element_id??inf.related_item_id??null;items.push({id:inf.id,item,title:item?await getItemTitle(item):null,subgroup:inf.filter_subgroup??null,reason:inf.reason??'',fecha:inf.date_created??null});}
 // Reacción: pausar la denunciada y lo parecido, y dejarlas bloqueadas para siempre.
 let reaccion=null;
 if(react){try{reaccion=await react(items);}catch(e){reaccion={error:e.code??String(e)};}}
 const value={motivo:'infraccion_pi',infracciones:items,reaccion};
 await query(`INSERT INTO ${FLAGS}(key,value,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at`,[FLAG,JSON.stringify(value),now]);
 const lines=items.map(i=>`- ${i.title??i.item??'(sin publicación)'}${i.item?` (${i.item})`:''}\n  ${i.subgroup??''}: ${i.reason}\n  ${i.fecha??''}`).join('\n');
 const pausadas=reaccion?.pausadas??[];
 const reaccionTexto=reaccion?.error?`No se pudieron pausar las parecidas (${reaccion.error}): revisalas a mano.`:`Se pausaron ${pausadas.length} publicaciones (la denunciada y las parecidas por editorial o patrón) y quedaron bloqueadas: no se reactivan ni se vuelven a publicar.${pausadas.length?'\n'+pausadas.slice(0,40).map(p=>`- ${p.title??p.id} (${p.id})`).join('\n')+(pausadas.length>40?`\n… y ${pausadas.length-40} más`:''):''}`;
 const mail=await send({asunto:`ALARMA: ${items.length} infracción${items.length>1?'es':''} de propiedad intelectual. Publicador FRENADO`,texto:`Mercado Libre marcó ${items.length===1?'una publicación':`${items.length} publicaciones`} de Amado Vintage por propiedad intelectual.\n\n${lines}\n\n${reaccionTexto}\n\nEl publicador quedó frenado y no publica más hasta que lo liberes: pedíselo a Claude o corré el workflow "Vintage publicador (nube)" con la acción liberar_freno.${runUrl?`\n\nCorrida: ${runUrl}`:''}`});
 return {baseline,nuevas_pi:items.length,denuncias_abiertas:cases===null?null:openCases.length,freno:value,reaccion,mail};
}

// Cliente real: lecturas, y la reacción (pausar la denunciada y las parecidas: PUT status paused).
const ITEM_FIELDS='id,title,status,seller_id,seller_custom_field,attributes';
const publisherOf=it=>(it?.attributes??[]).find(a=>['BOOK_PUBLISHER','PUBLISHER'].includes(a?.id))?.value_name??null;
export function makeReact(ml,query){
 return async items=>{
  const pausadas=[],errores=[];
  const pause=async it=>{try{if(String(it.seller_id)!==SELLER)return;if(it.status==='active')await ml.put(`/items/${it.id}`,{status:'paused'});pausadas.push({id:it.id,title:it.title,isbn:String(it.seller_custom_field??'').replace(/^AMADO-AR-/,'')});}catch(e){errores.push({id:it.id,error:e.code??String(e)});}};
  for(const i of items){
   if(!i.item)continue;
   let den;try{den=await ml.get(`/items/${i.item}?attributes=${ITEM_FIELDS}`);}catch{continue;}
   await pause(den);
   // Parecidas: todas las activas de la cuenta (scan) con misma editorial o mismo patrón.
   const all=[];let scroll=null;
   for(let page=0;page<400;page++){const q=new URLSearchParams({search_type:'scan',limit:'100',status:'active'});if(scroll)q.set('scroll_id',scroll);let r;try{r=await ml.get(`/users/${SELLER}/items/search?${q}`);}catch{break;}if(!Array.isArray(r?.results)||!r.results.length)break;all.push(...r.results);scroll=r.scroll_id??null;if(!scroll)break;}
   for(let k=0;k<all.length;k+=20){const group=all.slice(k,k+20);let r;try{r=await ml.get(`/items?ids=${group.join(',')}&attributes=${ITEM_FIELDS}`);}catch{continue;}const cands=(r??[]).filter(e=>e?.code===200&&e.body).map(e=>({...e.body,publisher:publisherOf(e.body)}));for(const sim of similarTo({...den,publisher:publisherOf(den)},cands))await pause(sim);}
  }
  const unique=[...new Map(pausadas.map(p=>[p.id,p])).values()];
  await blockItems(query,unique.map(p=>({item_id:p.id,isbn:p.isbn,motivo:'reaccion_denuncia'})));
  return {pausadas:unique,errores};
 };
}
// Otras señales, sólo lectura (Seba, 09/11/2026: vigilar cualquier tipo de suspensión):
//  - Avisos vigentes de Mercado Libre al vendedor (/communications/notices). Uno nuevo de propiedad
//    intelectual frena igual que una infracción; cualquier otro avisa por mail sin frenar.
//  - Reputación (una foto por día). Avisa si cambia el nivel o si cancelaciones o reclamos pasan
//    los valores de referencia de MercadoLíder (1,5 % y 2,5 %: no son umbrales de suspensión, sino alerta temprana).
export const REP_CANCEL_ALERT=0.015,REP_CLAIMS_ALERT=0.025;
const IP_NOTICE=/propiedad intelectual|replicas|falsific|copias no autorizadas|marca registrada|derechos de autor/i;
// Avisos del panel que advierten de una sanción aunque no sean de propiedad intelectual (por ejemplo, compras de cuentas vinculadas).
const SERIOUS_NOTICE=/sancion|suspend|suspens|inhabilit|retiramos|restring|no est[aá] permitido|prohibid/i;
const setBrake=async(query,value,now)=>{const before=(await query(`SELECT value FROM ${FLAGS} WHERE key=?`,[FLAG]))[0];await query(`INSERT INTO ${FLAGS}(key,value,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at`,[FLAG,JSON.stringify(value),now]);return !before||JSON.parse(before.value)?.motivo!==value.motivo;};
const levelNumber=level=>{const n=Number(String(level??'').match(/^\d+/)?.[0]);return Number.isFinite(n)?n:null;};
const uyDay=ms=>new Date(ms-3*3600000).toISOString().slice(0,10);
const plain=x=>String(x??'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
export async function watchSignals({query,getNotices=async()=>[],getReputation=async()=>null,getCompetencia=async()=>null,getAccountStatus=async()=>null,send=sendMail,now=Date.now(),runUrl=null}){
 await schema(query);
 const out={avisos_nuevos:0,avisos_pi:0,reputacion:null};
 // Avisos
 let notices=null;try{notices=await getNotices();}catch{notices=null;}
 if(notices){
  const armed=(await query(`SELECT value FROM ${FLAGS} WHERE key='avisos_armado'`))[0];
  if(!armed)await query(`INSERT OR IGNORE INTO ${FLAGS}(key,value,at) VALUES('avisos_armado','1',?)`,[now]);
  for(const n of notices){
   const id='notice:'+String(n?.id??'');if(id==='notice:')continue;
   if((await query(`SELECT id FROM ${SEEN} WHERE id=?`,[id]))[0])continue;
   const title=plain(n.title??n.label),detail=plain(n.description),ip=IP_NOTICE.test(title+' '+detail)?1:0;
   await query(`INSERT OR IGNORE INTO ${SEEN}(id,item_id,subgroup,ip,created,seen_at) VALUES(?,?,?,?,?,?)`,[id,null,'AVISO_'+String(n.category??''),ip,null,now]);
   if(!armed)continue; // la primera vez sólo se aprende lo vigente
   out.avisos_nuevos++;
   if(ip){
    out.avisos_pi++;
    const value={motivo:'aviso_pi',infracciones:[{id,item:null,title,subgroup:'AVISO_PANEL',reason:detail,fecha:null}],reaccion:null};
    await query(`INSERT INTO ${FLAGS}(key,value,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at`,[FLAG,JSON.stringify(value),now]);
    await send({asunto:'ALARMA: aviso nuevo de propiedad intelectual. Publicador FRENADO',texto:`Mercado Libre mandó un aviso nuevo a Amado Vintage:\n\n${title}\n${detail}\n\nEl publicador quedó frenado. Revisá las infracciones y las publicaciones antes de liberarlo.${runUrl?`\n\nDetalle: ${runUrl}`:''}`});
   }else if(SERIOUS_NOTICE.test(title+' '+detail)){
    out.avisos_graves=(out.avisos_graves??0)+1;
    await setBrake(query,{motivo:'aviso_grave',infracciones:[{id,item:null,title,subgroup:'AVISO_PANEL',reason:detail,fecha:null}],reaccion:null},now);
    await send({asunto:'ALARMA: aviso de advertencia de Mercado Libre. Publicador FRENADO',texto:`Mercado Libre mandó un aviso a Amado Vintage que advierte de una posible sanción:\n\n${title}\n${detail}\n\nEl publicador quedó frenado. Revisá el aviso en el panel y liberalo cuando lo hayas aclarado.${runUrl?`\n\nDetalle: ${runUrl}`:''}`});
   }else{
    await send({asunto:`aviso nuevo de Mercado Libre: ${title.slice(0,80)}`,texto:`Mercado Libre mandó un aviso nuevo a Amado Vintage (no advierte de sanciones, el publicador no se frenó):\n\n${title}\n${detail}${runUrl?`\n\nDetalle: ${runUrl}`:''}`});
   }
  }
 }
 // Reputación: una foto por día.
 let rep=null;try{rep=await getReputation();}catch{rep=null;}
 if(rep){
  const day=uyDay(now),prev=(await query(`SELECT value FROM ${FLAGS} WHERE key='reputacion'`))[0],before=prev?JSON.parse(prev.value):null;
  const m=rep.metrics??{},snap={day,level:rep.level_id??null,cancelaciones:m.cancellations?.rate??null,reclamos:m.claims?.rate??null,demoras:m.delayed_handling_time?.rate??null,ventas:m.sales?.completed??null};
  out.reputacion=snap;
  if(!before||before.day!==day){
   const motivos=[];
   if(before&&before.level&&snap.level&&before.level!==snap.level)motivos.push(`el nivel pasó de ${before.level} a ${snap.level}`);
   if(snap.cancelaciones!==null&&snap.cancelaciones>REP_CANCEL_ALERT)motivos.push(`las cancelaciones están en ${(snap.cancelaciones*100).toFixed(1)} % (referencia 1,5 %)`);
   if(snap.reclamos!==null&&snap.reclamos>REP_CLAIMS_ALERT)motivos.push(`los reclamos están en ${(snap.reclamos*100).toFixed(1)} % (referencia 2,5 %)`);
   await query(`INSERT INTO ${FLAGS}(key,value,at) VALUES('reputacion',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at`,[JSON.stringify(snap),now]);
   const peor=before&&levelNumber(before.level)!==null&&levelNumber(snap.level)!==null&&levelNumber(snap.level)<levelNumber(before.level);
   const umbral=(snap.cancelaciones!==null&&snap.cancelaciones>REP_CANCEL_ALERT)||(snap.reclamos!==null&&snap.reclamos>REP_CLAIMS_ALERT);
   if(peor||umbral){out.reputacion_frena=true;await setBrake(query,{motivo:'reputacion',infracciones:[{id:'reputacion',item:null,title:'Reputación de Vintage',subgroup:'REPUTACION',reason:motivos.join('; '),fecha:null}],reaccion:null},now);}
   if(motivos.length)await send({asunto:(peor||umbral?'ALARMA: ':'')+'reputación de Vintage: '+motivos[0]+(peor||umbral?'. Publicador FRENADO':''),texto:`Reputación de Amado Vintage al ${day}: ${motivos.join('; ')}.\n\nNivel ${snap.level}, ventas ${snap.ventas}, cancelaciones ${snap.cancelaciones===null?'sin dato':(snap.cancelaciones*100).toFixed(2)+' %'}, reclamos ${snap.reclamos===null?'sin dato':(snap.reclamos*100).toFixed(2)+' %'}, demoras de despacho ${snap.demoras===null?'sin dato':(snap.demoras*100).toFixed(2)+' %'}.\nLos valores de referencia son los de MercadoLíder: no son umbrales de suspensión, sino una alerta temprana.${runUrl?`\n\nDetalle: ${runUrl}`:''}`});
  }
 }

 // Estado de la cuenta: si Mercado Libre le sacó la venta o la publicación, es un problema real.
 let cuenta=null;try{cuenta=await getAccountStatus();}catch{cuenta=null;}
 if(cuenta&&(cuenta.vender===false||cuenta.publicar===false)){
  out.cuenta_restringida=true;
  const nuevo=await setBrake(query,{motivo:'cuenta_restringida',infracciones:[{id:'cuenta',item:null,title:'Estado de la cuenta',subgroup:'CUENTA',reason:`vender: ${cuenta.vender}, publicar: ${cuenta.publicar}, códigos: ${(cuenta.codigos??[]).join(', ')||'sin dato'}`,fecha:null}],reaccion:null},now);
  if(nuevo)await send({asunto:'ALARMA: Mercado Libre restringió la cuenta de Vintage. Publicador FRENADO',texto:`Amado Vintage figura sin permiso para ${cuenta.vender===false?'vender':''}${cuenta.vender===false&&cuenta.publicar===false?' y ':''}${cuenta.publicar===false?'publicar':''}. Códigos: ${(cuenta.codigos??[]).join(', ')||'sin dato'}.\n\nEl publicador quedó frenado.${runUrl?`\n\nDetalle: ${runUrl}`:''}`});
 }
 // Competencia en catálogo (price_to_win): una foto por día de una muestra de publicaciones. Seba (10/11/2026):
 // Mercado Libre marcó la cuenta como vendedor no confiable y no hay información pública de cuánto tarda en salir;
 // se mide acá. Avisa cuando aparece alguna que ya no tiene esa razón.
 let comp=null;try{comp=await getCompetencia();}catch{comp=null;}
 if(comp&&comp.total){
  const day=uyDay(now),prev=(await query(`SELECT value FROM ${FLAGS} WHERE key='competencia'`))[0],before=prev?JSON.parse(prev.value):null;
  const snap={day,total:comp.total,por_razon:comp.por_razon};
  out.competencia=snap;
  if(!before||before.day!==day){
   const noConf=m=>Object.entries(m??{}).filter(([k])=>/non_trusted_seller/.test(k)).reduce((a,[,v])=>a+v,0);
   const antes=before?noConf(before.por_razon)/before.total:null,ahora=noConf(snap.por_razon)/snap.total;
   await query(`INSERT INTO ${FLAGS}(key,value,at) VALUES('competencia',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at`,[JSON.stringify(snap),now]);
   if(antes!==null&&ahora<antes)await send({asunto:'catálogo de Vintage: cambió el estado de competencia',texto:`Competencia en catálogo al ${day}: de ${snap.total} publicaciones de la muestra, ${(ahora*100).toFixed(0)} % siguen con razón "vendedor no confiable" (antes ${(antes*100).toFixed(0)} %).\n\nDetalle: ${JSON.stringify(snap.por_razon)}${runUrl?`\n\nDetalle de la corrida: ${runUrl}`:''}`});
  }
 }
 return out;
}

export function mlReaders(query){
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:1});
 return {
  react:query?makeReact(ml,query):null,
  getInfractions:async offset=>{const r=await ml.get(`/moderations/infractions/${SELLER}?offset=${offset}&limit=10`);return Array.isArray(r?.infractions)?r.infractions:[];},
  getItemTitle:async id=>{try{return (await ml.get(`/items/${id}?attributes=title`))?.title??null;}catch{return null;}},
  getNotices:async()=>{const r=await ml.get('/communications/notices?limit=50&offset=0');return Array.isArray(r?.results)?r.results:[];},
  getReputation:async()=>(await ml.get(`/users/${SELLER}`))?.seller_reputation??null,
  getAccountStatus:async()=>{const u=await ml.get(`/users/${SELLER}`);return {vender:u?.status?.sell?.allow??null,publicar:u?.status?.list?.allow??null,codigos:[...(u?.status?.sell?.codes??[]),...(u?.status?.list?.codes??[])]};},
  getCompetencia:async()=>{
   if(!query)return null;
   const ids=(await query("SELECT item_id FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published' AND item_id IS NOT NULL ORDER BY RANDOM() LIMIT 20",[SELLER])).map(r=>r.item_id);
   const por_razon={};let total=0;
   for(const id of ids){try{const r=await ml.get(`/items/${id}/price_to_win?siteId=MLU&version=v2`);if(r?.status==='not_listed')continue;total++;const k=`${r?.status??'?'}|${[].concat(r?.reason??[]).join('+')||'sin_razon'}`;por_razon[k]=(por_razon[k]??0)+1;}catch{}}
   return {total,por_razon};
  },
  getCases:async()=>{const r=await ml.get('/moderations/pppi/cases?offset=0&date_created=&status=');const list=Array.isArray(r?.results)?r.results:Array.isArray(r?.cases)?r.cases:Array.isArray(r)?r:[];return list;},
 };
}
