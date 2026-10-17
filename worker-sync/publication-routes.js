import {OPERATIONS_PUBLIC_KEY,OPERATIONS_ISSUER} from './operations-read.js';
import {PUBLICATION_PATH,SELLER_ID,PublicationError,sha256,safeCode} from './publication-policy.js';
import {publicationService} from './publication-engine.js';
import {publicationStockSync} from './publication-stock-sync.js';
import {getAuthState} from './meli-auth.js';
import {sbsStockCommand} from './sbs-supplier-stock.js';
const response=(body,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const decode=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=')),c=>c.charCodeAt(0));
async function boundedBody(request){
 const reader=request.body?.getReader();if(!reader)return '';
 const chunks=[];let size=0;
 while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>524288){await reader.cancel();throw new PublicationError('body_too_large',413);}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return new TextDecoder().decode(bytes);
}
export async function verifyPublicationRequest(request,raw,{now=Date.now,publicKey=OPERATIONS_PUBLIC_KEY}={}){
 try{
  if(request.method!=='POST'||new URL(request.url).pathname!==PUBLICATION_PATH)throw Error();
  const header=request.headers.get('authorization')??'';
  if(header.length>8192||!header.startsWith('Amado-Signature '))throw Error();
  const parts=header.slice(16).split('.');if(parts.length!==2||parts.some(x=>!/^[\w-]+$/.test(x)))throw Error();
  const key=await crypto.subtle.importKey('jwk',publicKey,{name:'ECDSA',namedCurve:'P-256'},false,['verify']);
  if(!await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},key,decode(parts[1]),new TextEncoder().encode(parts[0])))throw Error();
  const claims=JSON.parse(new TextDecoder().decode(decode(parts[0]))),seconds=Math.floor(now()/1000);
  if(claims.v!==1||claims.iss!==OPERATIONS_ISSUER||claims.aud!=='amado-mercadolibre-publication'||claims.method!=='POST'||claims.path!==PUBLICATION_PATH||claims.seller_id!==SELLER_ID||!Number.isInteger(claims.iat)||!Number.isInteger(claims.exp)||claims.exp<=seconds||claims.iat>seconds+15||claims.exp<=claims.iat||claims.exp-claims.iat>60||!/^[a-f0-9-]{36}$/.test(claims.jti)||claims.body_sha256!==await sha256(raw))throw Error();
  return {id:claims.jti,expires:claims.exp*1000};
 }catch{throw new PublicationError('unauthorized_or_expired',401);}
}
export function createPublicationRoutes({service=publicationService,verify=verifyPublicationRequest,stockSync=publicationStockSync,authState=getAuthState,supplier=sbsStockCommand}={}){
 return async function handle(request,env,{admin=false}={}){
  try{
   const url=new URL(request.url);
   if(url.pathname==='/publisher/sbs-stock'){
    if(!admin)throw new PublicationError('unauthorized',401);
    if(request.method==='GET')return response({...await supplier(env,'status'),source:'SBS',read_only:true});
    if(request.method!=='POST')throw new PublicationError('method_not_allowed',405);
    if(!request.headers.get('content-type')?.startsWith('application/json'))throw new PublicationError('invalid_content_type',415);
    let input;try{input=JSON.parse(await boundedBody(request));}catch(e){if(e instanceof PublicationError)throw e;throw new PublicationError('invalid_json');}
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['action','args'].includes(k)))throw new PublicationError('invalid_command');
    return response({...await supplier(env,input.action,input.args??{}),source:'SBS',publication_writes:false});
   }
   if(admin&&request.method==='GET'&&url.pathname==='/publisher/status')return response({...await service.command(env,'status',{run_id:url.searchParams.get('run_id')||undefined}),seller_id:SELLER_ID,action:'status',source:'Amado publication queue',read_only:true});
   // OAuth state without credentials: confirms the D1 bootstrap and the real expiry.
   if(admin&&request.method==='GET'&&url.pathname==='/publisher/auth'){try{return response({...await authState(env),seller_id:SELLER_ID,action:'auth_state',read_only:true});}catch(error){return response({error:error?.code??'auth_state_unavailable'},503);}}
   // Stock sync: GET reports; POST runs one bounded pass under the configured ML_STOCK_SYNC_MODE.
   if(admin&&url.pathname==='/publisher/stock-sync'){
    if(request.method==='GET')return response({...await stockSync.status(env),seller_id:SELLER_ID,action:'stock_sync_status',read_only:true});
    if(request.method==='POST')return response({...await stockSync.sync(env),seller_id:SELLER_ID,action:'stock_sync'});
   }
   if(request.method!=='POST')throw new PublicationError('method_not_allowed',405);
   if(Number(request.headers.get('content-length'))>524288)throw new PublicationError('body_too_large',413);
   const raw=await boundedBody(request);
   const nonce=admin?null:await verify(request,raw);
   let body;try{body=JSON.parse(raw);}catch{throw new PublicationError('invalid_json');}
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['action','args'].includes(k)))throw new PublicationError('invalid_command');
   return response({...await service.command(env,body.action,body.args??{},nonce),seller_id:SELLER_ID,action:body.action,source:'Amado publication queue',read_only:['status','preview'].includes(body.action)});
  }catch(error){return response({error:safeCode(error)},error instanceof PublicationError?error.status:500);}
 };
}
export const handlePublicationRoute=createPublicationRoutes();
