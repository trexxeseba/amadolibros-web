import { vintagePilot } from '../_shared/meli-vintage-pilot.js';
import { VINTAGE_SELLER_ID } from '../_shared/meli-vintage-token.js';
import { OPERATIONS_PUBLIC_KEY, OPERATIONS_ISSUER } from '../../worker-sync/operations-read.js';
import { PublicationStore } from '../../worker-sync/publication-store.js';
import { PublicationError, sha256, safeCode } from '../../worker-sync/publication-policy.js';

export const VINTAGE_OPERATIONS_PATH='/operations/vintage';
const ORIGIN='https://www.amadolibros.com',AUDIENCE='amado-vintage-pilot';
const RUN='23413782-4900-4000-8000-000000000005';
const encode=new TextEncoder(),decode=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(s.length/4)*4,'=')),c=>c.charCodeAt(0));
const fail=(code,status=400)=>{throw new PublicationError(code,status);};
const response=(data,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'}});
export async function verifyVintageOperations(request,raw,{publicKey=OPERATIONS_PUBLIC_KEY,now=Date.now}={}){
 try{
  const header=request.headers.get('authorization')??'';
  if(header.length>8192||!header.startsWith('Amado-Signature '))throw Error();
  const parts=header.slice(16).split('.');if(parts.length!==2||parts.some(s=>!s||!/^[\w-]+$/.test(s)))throw Error();
  const key=await crypto.subtle.importKey('jwk',publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(parts[1]),encode.encode(parts[0])))throw Error();
  const c=JSON.parse(new TextDecoder().decode(decode(parts[0]))),seconds=Math.floor(now()/1000);
  if(c.v!==1||c.iss!==OPERATIONS_ISSUER||c.aud!==AUDIENCE||c.seller_id!==VINTAGE_SELLER_ID||c.method!=='POST'||c.path!==VINTAGE_OPERATIONS_PATH||!Number.isInteger(c.iat)||!Number.isInteger(c.exp)||c.iat>seconds+15||c.exp<=seconds||c.exp<=c.iat||c.exp-c.iat>60||!/^[a-f0-9-]{36}$/.test(c.jti)||c.body_sha256!==await sha256(raw))throw Error();
  return {id:c.jti,expires:c.exp*1000};
 }catch{fail('unauthorized_or_expired',401);}
}
async function bodyText(request){
 const reader=request.body?.getReader();if(!reader)return '';
 const chunks=[];let size=0;
 for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>4096){await reader.cancel();fail('body_too_large',413);}chunks.push(value);}
 const all=new Uint8Array(size);let offset=0;for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder().decode(all);
}
function argumentsFor(action,args){
 const commands={status:[],sources:[],prepare:['feed_id','source_run_id'],validate:['run_id'],approve:['run_id','policy_hash','sample_hash'],publish_approved:['run_id']};
 const fields=Object.hasOwn(commands,action)?commands[action]:null;
 if(!fields||!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!fields.includes(k)))fail('invalid_command');
 if(fields.includes('run_id')&&args.run_id!==RUN)fail('pilot_not_found',404);
 if(action==='prepare'&&['feed_id','source_run_id'].some(k=>typeof args[k]!=='string'||!/^[a-f0-9-]{36}$/.test(args[k])))fail('invalid_source');
 if(action==='approve'&&['policy_hash','sample_hash'].some(k=>typeof args[k]!=='string'||!/^[a-f0-9]{64}$/.test(args[k])))fail('sample_changed',409);
 return args;
}
function project(state){
 // Never return OAuth data, opaque scan cursors, leases, or raw publication payloads.
 return {seller_id:VINTAGE_SELLER_ID,limit:5,run:state.run,progress:state.progress?{phase:state.progress.phase,indexed:state.progress.indexed,index_complete:state.progress.index_complete,index_status:state.progress.index_status,busy:state.progress.busy,resume_at:state.progress.backoff_until,disabled:state.progress.disabled}:null,policy:state.policy,policy_hash:state.policy_hash,sample_hash:state.sample_hash,can_approve:state.can_approve??false,source_date:state.feed?.source_date,counts:state.summary?.counts??[],issues:state.issues??[],sample:(state.sample??[]).map(({isbn,title,price,state,item_id})=>({isbn,title,price,state,item_id}))};
}
async function consumeNonce(env,nonce){const s=new PublicationStore(env.ORDERS_DB,{sellerId:VINTAGE_SELLER_ID});await s.initialize();await s.nonce(nonce.id,nonce.expires,Date.now());}
export function createVintageOperations({pilot=vintagePilot,verify=verifyVintageOperations,consume=consumeNonce}={}){
 return async({request,env})=>{
  try{
   const url=new URL(request.url);
   if(url.origin!==ORIGIN||url.pathname!==VINTAGE_OPERATIONS_PATH||env.APP_ENV!=='production')fail('not_available',403);
   if(request.method!=='POST')fail('method_not_allowed',405);
   if(!request.headers.get('content-type')?.startsWith('application/json'))fail('invalid_content_type',415);
   if(Number(request.headers.get('content-length'))>4096)fail('body_too_large',413);
   const raw=await bodyText(request),nonce=await verify(request,raw);
   let body;try{body=JSON.parse(raw);}catch{fail('invalid_json');}
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','args'].includes(k)))fail('invalid_command');
   const {action}=body,args=argumentsFor(action,body.args??{});
   let data;
   if(action==='sources')data=await pilot.sources(env);
   else if(action==='status')data=project(await pilot.snapshot(env));
   else{
    await consume(env,nonce);
    const method={prepare:'prepare',validate:'advance',approve:'approve',publish_approved:'publishApproved'}[action];
    data=project(await pilot[method](env,args));
   }
   return response({...data,seller_id:VINTAGE_SELLER_ID,action,source:'Amado Vintage pilot',read_only:['sources','status'].includes(action),checked_at:new Date().toISOString()});
  }catch(e){return response({error:safeCode(e),seller_id:VINTAGE_SELLER_ID},e instanceof PublicationError?e.status:503);}
 };
}
export const onRequest=createVintageOperations();
