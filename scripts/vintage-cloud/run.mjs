// Publicador de Amado Vintage (seller 2341378249) en la nube, sin la PC.
//
// Corre en GitHub Actions (.github/workflows/vintage-nube.yml) con el mismo código que usaba la PC
// (scripts/vintage-local/): renew.mjs baja la lista de SBS con usuario y la carga a D1, el servidor
// emite una conexión temporal (el token de Mercado Libre lo sigue renovando Cloudflare), y la
// reserva por ISBN sigue en D1. Lo que en la PC era SQLite se arma de cero en cada corrida desde
// D1; el estado de pausas se guarda en D1 (ml_vintage_cloud_stock_sync).
//
// Acciones:
//   keepalive  sólo mantiene vigente el token de Vintage (Precio Ganador lo lee de D1).
//   numeros    baja la lista, la carga y cuenta (sin Mercado Libre).
//   prueba     numeros + qué pausaría o reactivaría + 5 altas preparadas sin enviar (nunca POST /items).
//   clasificar revisa candidatos en paralelo y los deja validados o descartados (sólo lecturas a
//              Mercado Libre, nunca POST /items). Lo validado lo aprovecha la próxima publicación.
//   publicar   pausa/reactiva según la lista (nunca toca precios: eso es de Precio Ganador) y publica
//              una tanda con freno diario. Exige campaign.json "ejecutor": "nube" y "nube.modo": "real".
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {renewConnection,makeRenewClient} from '../vintage-local/renew.mjs';
import {run as runEngine,inspectWorkbook,makeBroker,checkConfiguration,SELLER} from '../vintage-local/engine.mjs';
import {syncStock} from '../vintage-local/stock-sync.mjs';
import {openDatabase} from '../vintage-local/db.mjs';
import {campaignNumbers} from './numbers.mjs';
import {d1Client,loadStockState,saveStockState,STOCK_COLUMNS} from './d1.mjs';
import {watch,mlReaders,brakeOn,releaseBrake,blockedIds,blockedIsbns} from './vigia-pi.mjs';

export const ACTIONS=['keepalive','numeros','prueba','clasificar','publicar','liberar_freno'];
// Techo duro del día: el mismo VINTAGE_DAILY_CAP del servidor (functions/_shared/meli-vintage-bulk.js).
export const HARD_MAX_PER_RUN=1000,HARD_MAX_PER_DAY=10000;
// Ajustes del motor en la nube: lecturas cortadas a los 15 s (crear sigue en 60 s), estado del
// servidor cada 10 vueltas y el recorrido del inventario se conserva hasta 3 días.
// Además: no repite en create lo que validó prepare hace menos de 2 h, ni espera la descarga de fotos.
// Ficha de catálogo que da 404: se publica sin catálogo (Seba, 08/11/2026), y las que habían
// quedado en revisión por eso vuelven a la cola.
export const CLOUD_ENGINE={requestTimeoutMs:15000,statusEvery:10,keepIndexDays:3,trustPreparedMs:2*3600000,deferPictures:true,productNotFoundAsMissing:false,requeueReviewCodes:[],catalogOnly:true};
// Plan de retorno (Seba, 08/11/2026): sólo catálogo con ISBN, 25 altas por día, revisión diaria de
// infracciones. El publicador sigue apagado hasta el OK de Seba después de una semana limpia.
const CAMPAIGN=path.join(path.dirname(fileURLToPath(import.meta.url)),'..','vintage-local','campaign.json');
const problem=(code,detail={})=>Object.assign(new Error(code),{code,detail});

// Qué permite campaign.json. Publicar de verdad exige las dos llaves; los números salen de acá.
export function cloudSettings(campaign,{tanda,tope}={}){
 const nube=campaign?.nube??{},int=(v,d)=>Number.isInteger(Number(v))&&Number(v)>=0&&String(v).trim()!==''?Number(v):d;
 return {
  real:campaign?.ejecutor==='nube'&&nube.modo==='real',
  ejecutor:campaign?.ejecutor==='nube'?'nube':'pc',
  modo:nube.modo==='real'?'real':nube.modo==='apagado'?'apagado':'prueba',
  tanda:Math.min(HARD_MAX_PER_RUN,int(tanda,int(nube.tanda,50))),
  tope_diario:Math.min(HARD_MAX_PER_DAY,int(tope,int(nube.tope_diario,300))),
  minutos:Math.min(150,Math.max(5,int(nube.minutos,90))),
  // Separación entre pedidos a Mercado Libre: 2 s en la PC; la nube puede bajarla hasta 0,4 s.
  intervalo_ms:Math.min(2000,Math.max(250,int(nube.intervalo_ms,2000))),
  // Clasificadores en paralelo junto al publicador (0 = como la PC, un candidato por vez).
  clasificadores:Math.min(6,Math.max(0,int(nube.clasificadores,0))),
  // Para la acción clasificar (medición sin altas): cuántos en paralelo y a qué ritmo.
  clasificar:{clasificadores:Math.min(6,Math.max(1,int(nube.clasificar?.clasificadores,4))),intervalo_ms:Math.min(2000,Math.max(250,int(nube.clasificar?.intervalo_ms,250)))},
  target_total:Number.isInteger(campaign?.target_total)?campaign.target_total:10000,
 };
}
export function batchSize(settings,dailyCreated){return Math.max(0,Math.min(settings.tanda,settings.tope_diario-Math.max(0,Number(dailyCreated)||0)));}

async function syncWithD1State({query,directory,connection,excel,mode,intervalMs=2000,now=Date.now}){
 const db=openDatabase(path.join(directory,'publisher.sqlite'));
 try{
  await db.prepare(`CREATE TABLE IF NOT EXISTS vintage_stock_sync (isbn TEXT PRIMARY KEY,item_id TEXT NOT NULL,desired_status TEXT,applied_status TEXT,missing_since INTEGER NOT NULL DEFAULT 0,feed_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL DEFAULT 0,applied_price INTEGER,competitor_json TEXT,competitor_at INTEGER)`).run();
  for(const r of await loadStockState(query))await db.prepare(`INSERT OR REPLACE INTO vintage_stock_sync(${STOCK_COLUMNS.join(',')}) VALUES(${STOCK_COLUMNS.map(()=>'?').join(',')})`).bind(...STOCK_COLUMNS.map(c=>r[c]??null)).run();
 }finally{db.close();}
 const started=now(),summary=await syncStock({connection,excel,directory,mode,intervalMs,blockedIds:await blockedIds(query),now});
 let saved=0;
 if(mode!=='report'){
  const db2=openDatabase(path.join(directory,'publisher.sqlite'));
  try{saved=await saveStockState(query,(await db2.prepare(`SELECT ${STOCK_COLUMNS.join(',')} FROM vintage_stock_sync WHERE updated_at>=?`).bind(started).all()).results);}finally{db2.close();}
 }
 return {...summary,estado_guardado_en_d1:saved};
}

export async function cloudRun(options){
 const state={fase:'inicio'};
 try{return await cloudRunInner(options,state);}
 catch(error){error.fase=state.fase;throw error;}
}
async function cloudRunInner({action,directory,campaign,overrides={},env=process.env,query=null,deps={}},state){
 if(!ACTIONS.includes(action))throw problem('accion_invalida');
 const settings=cloudSettings(campaign,overrides),report={accion:action,cuenta:'Amado Vintage',seller_id:SELLER,ajustes:settings,inicio:new Date().toISOString()};
 if(action==='publicar'&&!settings.real)throw problem('publicar_no_habilitado',{ejecutor:settings.ejecutor,modo:settings.modo});
 const secret=env.VINTAGE_RENEW_SECRET;
 const post=(deps.renewClient??makeRenewClient)(secret);
 // El token se mantiene vivo siempre, aun con el publicador apagado: Precio Ganador lo necesita.
 state.fase='keepalive';report.token=await post('keepalive');
 // Vigía de propiedad intelectual: en toda corrida (aun apagado). Una infracción nueva pone el freno.
 state.fase='vigia_pi';
 const dq=query??d1Client();
 if(action==='liberar_freno'){await releaseBrake(dq);return {...report,estado:'freno_liberado'};}
 let vigiaOk=true;
 try{report.vigia_pi=await (deps.vigia??(()=>watch({query:dq,...mlReaders(dq),runUrl:env.RUN_URL??null})))();}
 catch(error){vigiaOk=false;report.vigia_pi={error:[error.code,error.message].find(x=>/^[a-z0-9_]{1,100}$/.test(x??''))??'vigia_fallo'};}
 if(action==='publicar'){
  // Freno puesto, o no se pudo mirar: no se publica (falla cerrada).
  const brake=await brakeOn(dq);
  if(brake)return {...report,estado:'frenado_por_infraccion_pi',freno:brake};
  if(!vigiaOk)return {...report,estado:'vigia_sin_datos'};
 }
 if(action==='keepalive')return {...report,estado:'token_vigente'};
 if(settings.modo==='apagado')return {...report,estado:'apagado'};
 const sbs=env.SBS_EMAIL&&env.SBS_PASSWORD?{email:env.SBS_EMAIL,password:env.SBS_PASSWORD}:null;
 if(!sbs)throw problem('sbs_credentials_missing');
 await fs.mkdir(directory,{recursive:true});
 const excel=path.join(directory,'sbs.xlsx'),connection=path.join(directory,'connection.json');
 try{
  state.fase='lista';report.lista=await (deps.renew??renewConnection)({excel,connection,secret,sbs,log:x=>console.log(JSON.stringify(x))});
 }catch(error){
  if(['supplier_stock_stale','supplier_stock_stale_or_future'].includes(error.code))return {...report,estado:'lista_vieja',detalle:error.detail};
  throw error;
 }
 try{
  state.fase='numeros';const c=JSON.parse(await fs.readFile(connection,'utf8')),policy=checkConfiguration(c);
  const input=await (deps.inspect??inspectWorkbook)(excel);
  report.numeros=campaignNumbers(input.rows,c.receipts,policy);
  if(action==='numeros')return {...report,estado:'listo'};
  state.fase='stock';const q=query??d1Client();
  if(action!=='clasificar')report.stock=await (deps.sync??syncWithD1State)({query:q,directory,connection,excel,mode:action==='publicar'?'stock_only':'report',intervalMs:settings.intervalo_ms});
  if(action==='clasificar'){
   state.fase='clasificar';
   const result=await (deps.engine??runEngine)({excel,connection,directory,target:settings.target_total,intervalMs:settings.clasificar.intervalo_ms,...CLOUD_ENGINE,classifiers:settings.clasificar.clasificadores,classifyOnly:true,maxMs:settings.minutos*60000,onStatus:x=>console.log(x)});
   const total=Object.values(result.classified??{}).reduce((a,b)=>a+b,0);
   report.clasificacion={estado:result.state,minutos:result.minutes,revisados:total,por_hora:result.minutes?Math.round(total*60/result.minutes):null,validados_por_hora:result.minutes?Math.round((result.classified?.validated??0)*60/result.minutes):null,resultado:result.classified,cola:result.counts};
   return {...report,estado:result.state};
  }
  if(action==='prueba'){
   state.fase='motor_prueba';let result;
   // Un corte de autorización a mitad del recorrido se reintenta: la base guardada sigue desde donde quedó.
   for(let intento=1;intento<=3;intento++){result=await (deps.engine??runEngine)({excel,connection,directory,validateOnly:5,target:settings.target_total,intervalMs:settings.intervalo_ms,...CLOUD_ENGINE,onStatus:x=>console.log(x)});if(result.state!=='auth_error')break;report.reintentos_autorizacion=intento;}
   let preview=[];try{preview=JSON.parse(await fs.readFile(path.join(directory,'items.preview.json'),'utf8'));}catch{}
   report.prueba={estado:result.state,altas_preparadas:preview.map(p=>({isbn:p.isbn,estado:p.state,precio:p.payload?.price??null,titulo:p.payload?.title??null,motivo:p.error_code??null}))};
   return {...report,estado:'prueba_lista'};
  }
  state.fase='motor';const status=await (deps.broker??makeBroker)(c)('status');
  const n=batchSize(settings,status.daily_created);
  report.freno={altas_hoy:status.daily_created,tope_diario:settings.tope_diario,tanda:n};
  if(n===0)return {...report,estado:'tope_diario_alcanzado'};
  let result;
  for(let intento=1;intento<=3;intento++){result=await (deps.engine??runEngine)({excel,connection,directory,limitNew:n,target:settings.target_total,raiseTargetTo:settings.target_total,intervalMs:settings.intervalo_ms,...CLOUD_ENGINE,classifiers:settings.clasificadores,shouldStop:()=>brakeOn(dq).then(Boolean).catch(()=>true),blockedIsbns:await blockedIsbns(q),maxMs:settings.minutos*60000,onStatus:x=>console.log(x)});if(result.state!=='auth_error')break;report.reintentos_autorizacion=intento;}
  const after=await (deps.broker??makeBroker)(c)('status');
  // Con el total de la campaña y no con las altas del día: el contador del día vuelve a 0 a la
  // medianoche y una corrida que la cruza parecía no haber publicado nada.
  const ganadas=Number.isFinite(after.published_total)&&Number.isFinite(status.published_total)?after.published_total-status.published_total:after.daily_created-status.daily_created;
  report.publicacion={estado:result.state,publicados_total:result.published_total,altas_de_esta_corrida:Math.max(0,ganadas)};
  return {...report,estado:result.state};
 }finally{
  // La conexión no queda abierta entre corridas: la próxima pide una nueva.
  await post('revoke').catch(()=>{});
  await fs.rm(connection,{force:true});
 }
}

const peso=n=>n===null||n===undefined?'—':'$ '+Number(n).toLocaleString('es-UY');
export function markdown(r){
 const lines=[`## Vintage en la nube: ${r.accion}`,'',`Estado: **${r.estado??r.error}**${r.error?` (${r.error}, fase ${r.fase})`:''}`,''];
 if(r.donde?.length)lines.push('```',...r.donde,'```','');
 const a=r.ajustes;if(a)lines.push(`Ejecutor: ${a.ejecutor} · modo: ${a.modo} · tanda: ${a.tanda} · tope diario: ${a.tope_diario}`,'');
 if(r.token)lines.push(`Token de Vintage: ${r.token.refreshed?'renovado':'vigente'}, vence ${new Date(r.token.expires_at).toLocaleString('es-UY',{timeZone:'America/Montevideo'})}`,'');
 if(r.lista)lines.push(`Lista de SBS: ${r.lista.source_date}, ${r.lista.rows?.toLocaleString('es-UY')} filas, cargada en D1.`,'');
 const n=r.numeros;
 if(n)lines.push('| | Libros |','|---|---:|',`| Filas en la lista | ${n.filas_lista} |`,`| Con stock en SBS | ${n.con_stock} |`,`| Publicados en Vintage | ${n.publicados} |`,`| Altas sin confirmar | ${n.sin_confirmar} |`,`| Publicados que hoy no tienen stock | ${n.publicados_sin_stock_hoy} |`,`| **Candidatos a publicar** | **${n.candidatos_nuevos}** |`,'',`Precio completo de los candidatos (antes de mirar al ganador): mínimo ${peso(n.precio_lista_completo.minimo)}, mediana ${peso(n.precio_lista_completo.mediana)}, 90 % por debajo de ${peso(n.precio_lista_completo.p90)}.`,'');
 if(r.stock)lines.push(`Stock: ${r.stock.mode==='report'?'(sólo informe) ':''}publicados ${r.stock.published??'—'}, con stock ${r.stock.in_stock??'—'}, faltan ${r.stock.missing??'—'}${r.stock.suspicious_feed?' (lista incompleta: no se pausa nada)':''}; pausados ${r.stock.paused??0}, reactivados ${r.stock.activated??0}.`,'');
 if(r.prueba){lines.push(`Prueba de altas (no se envió nada a Mercado Libre): ${r.prueba.estado}`,'','| ISBN | Estado | Precio | Título |','|---|---|---:|---|');for(const p of r.prueba.altas_preparadas)lines.push(`| ${p.isbn} | ${p.estado}${p.motivo?' ('+p.motivo+')':''} | ${peso(p.precio)} | ${(p.titulo??'').replace(/\|/g,'/')} |`);lines.push('');}
 if(r.clasificacion){const c=r.clasificacion;lines.push(`Clasificación (sin publicar): ${c.revisados} candidatos en ${c.minutos} min (${c.por_hora}/h), validados ${c.resultado?.validated??0} (${c.validados_por_hora}/h).`,'','```',JSON.stringify(c.resultado),'```','');}
 if(r.freno)lines.push(`Freno: ${r.freno.altas_hoy} altas hoy, tope ${r.freno.tope_diario}, tanda de esta corrida ${r.freno.tanda}.`,'');
 if(r.publicacion)lines.push(`Publicación: ${r.publicacion.altas_de_esta_corrida} altas nuevas; total ${r.publicacion.publicados_total}.`,'');
 return lines.join('\n');
}

async function main(){
 const args=process.argv.slice(2),get=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
 const action=get('--accion')??'prueba',directory=get('--dir'),out=get('--salida');
 let report;
 try{
  const campaign=JSON.parse(await fs.readFile(CAMPAIGN,'utf8'));
  report=await cloudRun({action,directory,campaign,overrides:{tanda:get('--tanda'),tope:get('--tope')}});
 }catch(error){
  const code=[error.code,error.message].find(x=>/^[a-z0-9_]{1,100}$/.test(x??''))??'fallo_nube';
  // Dónde falló: fase y primeras líneas de la pila con rutas del repo (sin valores ni claves).
  const donde=String(error.stack??'').split('\n').filter(l=>/scripts\/|functions\/|worker-sync\//.test(l)).slice(0,4).map(l=>l.trim().replace(/^at /,'').replace(/.*amadolibros-web\//,'').replace(/\)$/,''));
  report={accion:action,estado:'fallo',error:code,fase:error.fase??null,http:error.status??error.detail?.http_status??null,donde,detalle:error.detail??{}};
  console.error(JSON.stringify({fase:report.fase,error:code,donde}));
  process.exitCode=1;
 }
 if(out){await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'reporte.json'),JSON.stringify(report,null,2));await fs.writeFile(path.join(out,'reporte.md'),markdown(report));}
 if(process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,markdown(report)+'\n');
 // El reporte también va al registro (sólo conteos y estados, nunca claves).
 console.log('=== REPORTE ===\n'+JSON.stringify(report));
 console.log(JSON.stringify({estado:report.estado,error:report.error??null}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
