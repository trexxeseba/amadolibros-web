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

export const SELLER='2341378249';
export const FLAG='freno_pi';
const SEEN='ml_vintage_cloud_infractions_seen',FLAGS='ml_vintage_cloud_flags';

// ¿Es una infracción de propiedad intelectual? Por subgrupo o por el texto del motivo.
export function isIp(infraction){
 const sub=String(infraction?.filter_subgroup??'');
 const reason=String(infraction?.reason??'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
 return /COPIAS|REPLICA|PI_|FAKE|COUNTERFEIT|INTELLECTUAL|PPPI/i.test(sub)||/propiedad intelectual|falsific|no era original|originalidad|replica|copia no autorizada/.test(reason);
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
export async function watch({query,getInfractions,getItemTitle=async()=>null,send=sendMail,now=Date.now(),runUrl=null,maxPages=80}){
 await schema(query);
 const known=(await query(`SELECT COUNT(*) n FROM ${SEEN}`))[0]?.n??0;
 const baseline=Number(known)===0;
 const fresh=[];
 for(let page=0;page<maxPages;page++){
  const list=await getInfractions(page*10);
  if(!list.length)break;
  for(const inf of list){
   const id=String(inf.id??'');if(!id)continue;
   const seen=(await query(`SELECT id FROM ${SEEN} WHERE id=?`,[id]))[0];
   if(seen)continue;
   const ip=isIp(inf)?1:0;
   await query(`INSERT OR IGNORE INTO ${SEEN}(id,item_id,subgroup,ip,created,seen_at) VALUES(?,?,?,?,?,?)`,[id,inf.element_id??inf.related_item_id??null,inf.filter_subgroup??null,ip,inf.date_created??null,now]);
   if(ip&&!baseline)fresh.push(inf);
  }
  // Se recorren todas las páginas (no se confía en el orden): son pocas llamadas por hora.
  if(list.length<10)break;
 }
 if(!fresh.length)return {baseline,nuevas_pi:0,freno:await brakeOn(query)};
 const items=[];
 for(const inf of fresh){const item=inf.element_id??inf.related_item_id??null;items.push({id:inf.id,item,title:item?await getItemTitle(item):null,subgroup:inf.filter_subgroup??null,reason:inf.reason??'',fecha:inf.date_created??null});}
 const value={motivo:'infraccion_pi',infracciones:items};
 await query(`INSERT INTO ${FLAGS}(key,value,at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,at=excluded.at`,[FLAG,JSON.stringify(value),now]);
 const lines=items.map(i=>`- ${i.title??i.item??'(sin publicación)'}${i.item?` (${i.item})`:''}\n  ${i.subgroup??''}: ${i.reason}\n  ${i.fecha??''}`).join('\n');
 const mail=await send({asunto:`ALARMA: ${items.length} infracción${items.length>1?'es':''} de propiedad intelectual. Publicador FRENADO`,texto:`Mercado Libre marcó ${items.length===1?'una publicación':`${items.length} publicaciones`} de Amado Vintage por propiedad intelectual. El publicador quedó frenado y no publica más hasta que lo liberes.\n\n${lines}\n\nPara volver a publicar: pedile a Claude que libere el freno, o corré el workflow "Vintage publicador (nube)" con la acción liberar_freno.${runUrl?`\n\nCorrida: ${runUrl}`:''}`});
 return {baseline,nuevas_pi:items.length,freno:value,mail};
}

// Cliente real (sólo GET): infracciones y título de una publicación.
export function mlReaders(){
 const ml=crearCliente(fuenteTokenD1(CUENTAS.vintage),{concurrencia:1});
 return {
  getInfractions:async offset=>{const r=await ml.get(`/moderations/infractions/${SELLER}?offset=${offset}&limit=10`);return Array.isArray(r?.infractions)?r.infractions:[];},
  getItemTitle:async id=>{try{return (await ml.get(`/items/${id}?attributes=title`))?.title??null;}catch{return null;}},
 };
}
