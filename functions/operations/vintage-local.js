import {createLocalAccess} from '../_shared/vintage-local-access.js';
import {PublicationError,safeCode} from '../../worker-sync/publication-policy.js';
const headers={'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer'};
export function createLocalAccessRoute({access=createLocalAccess()}={}){return async({request,env})=>{
 if(new URL(request.url).origin!=='https://www.amadolibros.com'||env.APP_ENV!=='production')return Response.json({error:'not_available'},{status:403,headers});
 if(request.method!=='POST'||!request.headers.get('content-type')?.startsWith('application/json'))return Response.json({error:'invalid_request'},{status:400,headers});
 try{
  const reader=request.body?.getReader();let text='';if(!reader)throw new PublicationError('invalid_body');
  for(;;){const {done,value}=await reader.read();if(done)break;text+=new TextDecoder().decode(value);if(text.length>2048){await reader.cancel();throw new PublicationError('body_too_large',413);}}
  const body=JSON.parse(text),fields={token:[],invalidate:['access_token'],reserve:['isbn','policy_hash'],report:['isbn','state','item_id'],status:[]};
  if(!body||Object.keys(body).some(k=>!['action','args'].includes(k))||!Object.hasOwn(fields,body.action)||!body.args||Array.isArray(body.args)||Object.keys(body.args).some(k=>!fields[body.action].includes(k)))throw new PublicationError('invalid_local_action');
  return Response.json(await access.command(env,request.headers.get('authorization')?.replace(/^Bearer /,''),body.action,body.args),{headers});
 }catch(e){return Response.json({error:safeCode(e)}, {status:e instanceof PublicationError?e.status:503,headers});}
};}
export const onRequest=createLocalAccessRoute();
