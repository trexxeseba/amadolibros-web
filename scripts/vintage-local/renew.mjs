// Renueva desde la PC la conexión local de Vintage, sin navegador.
//
// 1. Inicia sesión en el portal de SBS (ag.sbs.com.ar) con el usuario del dueño y
//    descarga "Lista completa de disponibles". Sin credenciales usa el archivo
//    público, que SBS dejó de actualizar en agosto de 2026.
// 2. Lo lee con el mismo lector que el panel (misma fecha interna y mismo hash).
// 3. Revoca la conexión anterior, carga el stock en D1 y pide una conexión nueva
//    a /operations/vintage-renew con VINTAGE_RENEW_SECRET.
// 4. Guarda la conexión en el archivo que usa engine.mjs.
// No hace ninguna llamada a Mercado Libre ni crea publicaciones.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectWorkbook,checkConfiguration} from './engine.mjs';
import {stockIsFresh} from '../../worker-sync/publication-policy.js';

export const SBS_SOURCE='https://sbs-distribuidora-lista.s3.sa-east-1.amazonaws.com/Listado+completo+de+libros.xlsx';
export const SBS_PORTAL='https://ag.sbs.com.ar';
export const SBS_PORTAL_LIST='/Home/AllPriceList';
export const RENEW_ENDPOINT='https://www.amadolibros.com/operations/vintage-renew';
const MAX_BYTES=64*1024*1024,MIN_ROWS=10000,REDIRECTS=[301,302,303,307,308];
const problem=(code,detail={})=>Object.assign(new Error(code),{code,detail});

export function feedIdFromHash(hash){
 if(!/^[a-f0-9]{64}$/.test(hash))throw problem('invalid_stock_hash');
 return `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
}
async function writeAtomic(file,data){
 await fs.mkdir(path.dirname(file),{recursive:true});
 const temp=file+'.tmp';await fs.writeFile(temp,data);await fs.rename(temp,file);
}
// Tarro de cookies mínimo: nombre=valor por respuesta, sin atributos. Sólo se envía al portal.
function cookieJar(){
 const jar=new Map();
 return {
  add(response){for(const raw of response.headers.getSetCookie?.()??[]){const pair=raw.split(';')[0],i=pair.indexOf('=');if(i>0)jar.set(pair.slice(0,i).trim(),pair.slice(i+1).trim());}},
  header(){return [...jar].map(([k,v])=>`${k}=${v}`).join('; ');},
 };
}
// Login del portal ASP.NET de SBS: GET del formulario (token antifalsificación en cookie y
// campo oculto), POST con Email/Password. Un 302 es sesión iniciada; un 200 devuelve el
// formulario con el error (clave incorrecta) y se rechaza sin reintentar.
export async function sbsLogin({email,password,portal=SBS_PORTAL,fetcher=fetch}){
 if(typeof email!=='string'||!email.includes('@')||typeof password!=='string'||password.length<4)throw problem('sbs_credentials_missing');
 const jar=cookieJar(),login=`${portal}/Account/Login?ReturnUrl=${encodeURIComponent(SBS_PORTAL_LIST)}`;
 const page=await fetcher(login,{redirect:'manual',signal:AbortSignal.timeout(60000)});
 jar.add(page);
 const token=page.ok?(await page.text()).match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)?.[1]:null;
 if(!token)throw problem('sbs_login_page_unavailable',{http_status:page.status});
 const body=new URLSearchParams({__RequestVerificationToken:token,Email:email,Password:password}).toString();
 const response=await fetcher(login,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Cookie:jar.header()},body,redirect:'manual',signal:AbortSignal.timeout(60000)});
 jar.add(response);
 if(!REDIRECTS.includes(response.status))throw problem('sbs_login_rejected',{http_status:response.status});
 return {cookie:jar.header(),source:portal+SBS_PORTAL_LIST,origin:new URL(portal).origin};
}
// Descarga siguiendo redirecciones a mano (p. ej. a un enlace firmado de S3) y enviando la
// cookie sólo al origen del portal. Una respuesta HTML es el formulario de login, no stock.
export async function downloadStock(source,{fetcher=fetch,cookie='',origin=''}={}){
 let url=source;
 for(let hop=0;hop<5;hop++){
  const headers={'Cache-Control':'no-cache'};
  if(cookie&&origin&&new URL(url).origin===origin)headers.Cookie=cookie;
  const response=await fetcher(url,{headers,redirect:'manual',signal:AbortSignal.timeout(120000)});
  if(REDIRECTS.includes(response.status)){
   const location=response.headers.get('location');if(!location)throw problem('supplier_download_failed',{http_status:response.status});
   url=new URL(location,url).href;if(/\/Account\/Login/i.test(url))throw problem('supplier_login_required');continue;
  }
  if(!response.ok||!response.body)throw problem('supplier_download_failed',{http_status:response.status});
  if(/text\/html/i.test(response.headers.get('content-type')??''))throw problem('supplier_login_required',{http_status:response.status});
  const reader=response.body.getReader(),chunks=[];let length=0;
  for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>MAX_BYTES){await reader.cancel();throw problem('supplier_file_too_large');}chunks.push(value);}
  return Buffer.concat(chunks);
 }
 throw problem('supplier_download_redirect_loop');
}
export function makeRenewClient(secret,{fetcher=fetch,endpoint=RENEW_ENDPOINT}={}){
 if(typeof secret!=='string'||secret.length<32)throw problem('renew_secret_missing');
 return async(action,args={})=>{
  const response=await fetcher(endpoint,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({action,args}),redirect:'manual',signal:AbortSignal.timeout(90000)});
  let body;try{body=await response.json();}catch{throw problem('renew_invalid_response',{http_status:response.status});}
  if(!response.ok)throw problem(/^[a-z0-9_]{1,100}$/.test(body?.error??'')?body.error:'renew_rejected',{http_status:response.status,action});
  return body;
 };
}
export async function renewConnection({excel,connection,secret,source,sbs=null,fetcher=fetch,inspect=inspectWorkbook,now=Date.now,log=()=>{}}){
 let download={source:source||SBS_SOURCE};
 if(sbs){log({step:'login',portal:sbs.portal||SBS_PORTAL});download=await sbsLogin({...sbs,fetcher});if(source)download.source=source;}
 const bytes=await downloadStock(download.source,{fetcher,cookie:download.cookie,origin:download.origin});
 await writeAtomic(excel,bytes);
 const input=await inspect(excel);
 if(!stockIsFresh(input.source_date,now()))throw problem('supplier_stock_stale',{source_date:input.source_date});
 if(!Array.isArray(input.rows)||input.rows.length<MIN_ROWS)throw problem('supplier_rows_below_minimum',{rows:input.rows?.length??0});
 const feed_id=feedIdFromHash(input.source_sha256),post=makeRenewClient(secret,{fetcher});
 log({step:'revoke'});await post('revoke');
 const begin=await post('begin',{feed_id,source_date:input.source_date,source_sha256:input.source_sha256,expected_rows:input.rows.length});
 if(begin.state!=='ready'){
  for(let i=0;i<input.rows.length;i+=200){await post('import',{feed_id,rows:input.rows.slice(i,i+200)});if(i%2000===0)log({step:'import',done:Math.min(i+200,input.rows.length),total:input.rows.length});}
  await post('commit',{feed_id});
 }
 log({step:'renew'});
 const c=await post('renew',{feed_id});
 checkConfiguration(c);
 await writeAtomic(connection,JSON.stringify(c,null,2));
 return {state:'renewed',feed_id,source_date:input.source_date,rows:input.rows.length,expires_at:c.expires_at,published_receipts:(c.receipts??[]).filter(r=>r.state==='published').length};
}
// PowerShell 5.1 (Set-Content -Encoding UTF8) escribe un BOM al principio, que JSON.parse rechaza.
export async function readSbsFile(file){
 const saved=JSON.parse((await fs.readFile(file,'utf8')).replace(/^﻿/,''));
 return {email:saved.email,password:saved.password,portal:saved.portal};
}
async function main(){
 const args=process.argv.slice(2),get=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
 let secret=process.env.VINTAGE_RENEW_SECRET;
 if(!secret&&get('--secret-file'))secret=(await fs.readFile(get('--secret-file'),'utf8')).trim();
 let sbs=process.env.SBS_EMAIL&&process.env.SBS_PASSWORD?{email:process.env.SBS_EMAIL,password:process.env.SBS_PASSWORD}:null;
 try{
  if(!sbs&&get('--sbs-file'))sbs=await readSbsFile(get('--sbs-file'));
  const result=await renewConnection({excel:get('--excel'),connection:get('--connection'),secret,source:get('--source'),sbs,log:x=>console.log(JSON.stringify(x))});
  console.log(JSON.stringify(result));
 }catch(error){
  const code=/^[a-z0-9_]{1,100}$/.test(error.code??'')?error.code:'renew_failed';
  console.log(JSON.stringify({state:'failed',error:code,...(error.detail??{})}));
  process.exitCode=code==='supplier_stock_stale'||code==='supplier_stock_stale_or_future'?3:2;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
