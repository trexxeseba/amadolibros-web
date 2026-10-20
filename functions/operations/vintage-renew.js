import {createVintageRenew,RENEW_FIELDS} from '../_shared/vintage-renew.js';
import {PublicationError,safeCode} from '../../worker-sync/publication-policy.js';
const headers={'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'};
const MAX_BODY=524288;
export function createRenewRoute({renew=createVintageRenew()}={}){return async({request,env})=>{
 if(new URL(request.url).origin!=='https://www.amadolibros.com'||env.APP_ENV!=='production')return Response.json({error:'not_available'},{status:403,headers});
 if(request.method!=='POST'||!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'invalid_request'},{status:400,headers});
 try{
  const reader=request.body?.getReader();if(!reader)throw new PublicationError('invalid_body');
  const chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BODY){await reader.cancel();throw new PublicationError('body_too_large',413);}chunks.push(value);}
  const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.byteLength;}
  let body;try{body=JSON.parse(new TextDecoder().decode(bytes));}catch{throw new PublicationError('invalid_json',400);}
  const args=body?.args??{};
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','args'].includes(k))||!Object.hasOwn(RENEW_FIELDS,body.action)||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!RENEW_FIELDS[body.action].includes(k)))throw new PublicationError('invalid_renew_action',400);
  return Response.json(await renew.command(env,request.headers.get('authorization'),body.action,args),{headers});
 }catch(e){return Response.json({error:safeCode(e)},{status:e instanceof PublicationError?e.status:503,headers});}
};}
export const onRequest=createRenewRoute();
