import {deriveSessionSecret,hasValidSession,resolvePanelConfig} from '../_shared/panel-auth.js';
import {createVintageBulk} from '../_shared/meli-vintage-bulk.js';
import {PublicationError,safeCode} from '../../worker-sync/publication-policy.js';
const origin='https://www.amadolibros.com',headers={'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin'};
const reply=(body,status=200)=>Response.json(body,{status,headers});
export function createVintageBulkPage({bulk}={}){
 return async({request,env})=>{
  const url=new URL(request.url),config=resolvePanelConfig(env);
  if(url.origin!==origin||env.APP_ENV!=='production')return reply({error:'not_available'},403);
  if(!config.ok||!await hasValidSession(request,await deriveSessionSecret(config.password)))return new Response('<h1>Ingresá al panel</h1><a href="/panel">Entrar al panel</a>',{status:401,headers:{...headers,'Content-Type':'text/html;charset=utf-8'}});
  const service=bulk??createVintageBulk();
  if(request.method==='GET'){
   if(url.searchParams.get('format')==='status')return reply(await service.status(env));
   return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Lote de Vintage</title><style>body{font:18px system-ui;max-width:1050px;margin:30px auto;padding:24px;line-height:1.6}button,input{font:inherit;padding:12px;margin:10px}table{border-collapse:collapse;width:100%}td,th{padding:10px;border-bottom:1px solid #ccc;text-align:left}.box{padding:20px;background:#f6f5ef;border-radius:12px}a{color:#134bb0}</style><h1>Publicación por tandas en Vintage</h1><p><strong>AMADO_VINTAGE · seller 2341378249</strong></p><p>Objetivo: 10.000 publicaciones en total, incluidas las cinco del piloto. Se conserva su política de precios y disponibilidad de 18 días. Cada ISBN se publica una sola vez por vendedor. Amado Libros queda fuera de este proceso.</p><section class="box"><label>Excel actualizado de stock SBS <input type="file" accept=".xlsx" id="stock"></label><button id="load">Cargar Excel y preparar el lote</button><p id="upload" role="status"></p></section><p id="state" role="status">Consultando estado…</p><p id="details"></p><button id="start" disabled>Iniciar / continuar las tandas en Vintage</button><button id="pause">Pausar</button><button id="refresh">Actualizar estado</button><p>Una publicación a la vez, consultas espaciadas y tandas de 25 con pausa. Presupuesto interno de 30 consultas/minuto y hasta 1.000 altas diarias; Mercado Libre puede imponer límites menores. Un 429 guarda una pausa creciente y respeta Retry-After. Un alta incierta se revisa antes de otro intento.</p><p><strong>Dejá esta pestaña abierta para continuar automáticamente.</strong> El avance queda guardado si la cerrás. Se detiene al vencer el stock y necesita un Excel vigente para seguir.</p><h2>Últimas publicaciones del lote</h2><div id="items"></div><h2>Casos para revisar</h2><div id="issues"></div><a href="/panel/meli-vintage-piloto">Ver las cinco del piloto</a><script type="module" src="/assets/meli-vintage-bulk.js"></script></html>`,{headers:{...headers,'Content-Type':'text/html;charset=utf-8','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; worker-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}});
  }
  if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
  if(request.headers.get('origin')!==origin||!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'invalid_origin_or_type'},403);
  try{
   const reader=request.body?.getReader();if(!reader)return reply({error:'invalid_json'},400);
   const chunks=[];let length=0;for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>524288){await reader.cancel();return reply({error:'body_too_large'},413);}chunks.push(value);}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply({error:'invalid_json'},400);}
   const fields={begin:['feed_id','source_date','source_sha256','expected_rows'],import:['feed_id','rows'],commit:['feed_id'],start:['feed_id','policy_hash'],pause:['run_id'],tick:['run_id']};
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','args'].includes(k))||!Object.hasOwn(fields,body.action)||!body.args||typeof body.args!=='object'||Array.isArray(body.args)||Object.keys(body.args).some(k=>!fields[body.action].includes(k)))return reply({error:'invalid_bulk_action'},400);
   return reply(await service.command(env,body.action,body.args));
  }catch(e){return reply({error:safeCode(e)},e instanceof PublicationError?e.status:503);}
 };
}
export const onRequest=createVintageBulkPage();
