import {deriveSessionSecret,hasValidSession,resolvePanelConfig} from '../_shared/panel-auth.js';
import {vintagePilot} from '../_shared/meli-vintage-pilot.js';
import {PublicationError,safeCode} from '../../worker-sync/publication-policy.js';
const reply=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff'}});
export function createVintageStockUpload({pilot=vintagePilot}={}){
 return async({request,env})=>{
  const url=new URL(request.url),origin='https://www.amadolibros.com';
  if(url.origin!==origin||env.APP_ENV!=='production')return reply({error:'not_available'},403);
  const config=resolvePanelConfig(env);
  if(!config.ok||!await hasValidSession(request,await deriveSessionSecret(config.password)))return reply({error:'panel_session_required'},401);
  if(request.method!=='POST')return reply({error:'method_not_allowed'},405);
  if(request.headers.get('origin')!==origin||!request.headers.get('content-type')?.startsWith('application/json'))return reply({error:'invalid_origin_or_type'},403);
  if(Number(request.headers.get('content-length'))>65536)return reply({error:'body_too_large'},413);
  try{
   const reader=request.body?.getReader();if(!reader)return reply({error:'invalid_upload'},400);
   const chunks=[];let size=0;
   for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536){await reader.cancel();return reply({error:'body_too_large'},413);}chunks.push(value);}
   const bytes=new Uint8Array(size);let pos=0;for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.byteLength;}
   let args;try{args=JSON.parse(new TextDecoder().decode(bytes));}catch{return reply({error:'invalid_json'},400);}
   if(!args||typeof args!=='object'||Array.isArray(args))return reply({error:'invalid_upload'},400);
   return reply({...await pilot.refreshStock(env,args),seller_id:'2341378249',publication_writes:false});
  }catch(e){return reply({error:safeCode(e)},e instanceof PublicationError?e.status:503);}
 };
}
export const onRequest=createVintageStockUpload();
