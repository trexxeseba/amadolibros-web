// Sincronización de stock de Amado Vintage desde la PC.
//
// Compara cada publicación creada por la campaña (recibos `published` de la conexión y
// del SQLite local) con la lista fresca del proveedor que acaba de bajar renew.mjs:
//  - un ISBN ausente o sin stock se pausa (status paused) tras el período de gracia;
//  - un ISBN que vuelve con stock se reactiva sólo si la pausa fue de esta
//    sincronización o por agotamiento (cantidad 0); una pausa manual queda manual;
//  - nunca se cierra ni se borra una publicación, nunca se toca un ítem cuyo
//    vendedor o SKU no coincidan, y una lista sospechosamente incompleta
//    (más de maxMissingPct de faltantes) no pausa nada;
//  - en modo pause_and_reactivate, además ajusta el precio (sube o baja) al que da la
//    política aprobada con el precio de lista de hoy, nunca por debajo del mínimo, y no
//    toca un precio que se mueva más del doble o a menos de la mitad (dato sospechoso).
// Lee el estado real en /items/bulk antes de cada PUT y registra lo aplicado en
// la tabla vintage_stock_sync de publisher.sqlite. Mismo reloj de 2 s que el motor.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {SELLER,checkConfiguration,makeBroker,inspectWorkbook} from './engine.mjs';
import {openDatabase} from './db.mjs';
import {createPublicationMeli,MercadoLibreError} from '../../worker-sync/publication-meli.js';
import {hasSupplierStock,stockIsFresh,safeCode,quoteMercadoLibre} from '../../worker-sync/publication-policy.js';
import {bulkItemsPath,bulkEntryItem} from '../../worker-sync/meli-bulk.js';
import {createVintageBulkFetch} from '../../functions/_shared/meli-vintage-bulk.js';

export const MODES=['report','pause_only','pause_and_reactivate'];
export const ITEM_FIELDS='id,seller_id,status,available_quantity,seller_custom_field,price,currency_id';
export const MAX_PRICE_RATIO=2;
const SCHEMA=`CREATE TABLE IF NOT EXISTS vintage_stock_sync (isbn TEXT PRIMARY KEY,item_id TEXT NOT NULL,desired_status TEXT,applied_status TEXT,missing_since INTEGER NOT NULL DEFAULT 0,feed_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL DEFAULT 0)`;
const TRANSIENT_MS=300000,LONG_MS=86400000;

export async function syncStock({connection,excel,directory,mode='pause_and_reactivate',graceHours=0,maxMissingPct=30,batch=500,apiFactory=createPublicationMeli,brokerFactory=makeBroker,readWorkbook=inspectWorkbook,now=Date.now,onStatus=()=>{}}){
 if(!MODES.includes(mode))throw new Error('invalid_stock_sync_mode');
 const c=JSON.parse(await fs.readFile(connection,'utf8')),policy=checkConfiguration(c);
 const input=await readWorkbook(excel);
 if(!stockIsFresh(input.source_date,now())||input.source_sha256!==c.source_sha256)throw new Error('workbook_does_not_match_current_approved_stock');
 const feedTime=Date.parse(input.source_date),graceMs=graceHours*3600000;
 await fs.mkdir(directory,{recursive:true});
 const db=openDatabase(path.join(directory,'publisher.sqlite')),stmt=(sql,...args)=>db.prepare(sql).bind(...args);
 const env={ORDERS_DB:db,USER_ID:SELLER,APP_ID:c.app_id};
 const broker=brokerFactory(c),limited=createVintageBulkFetch();
 let tokenCache=null;
 const api=apiFactory({sellerId:SELLER,timeouts:{request:60000,create:60000},tokenProvider:async()=>{if(!tokenCache||tokenCache.expires_at<now()+15000)tokenCache=await broker('token');return tokenCache.access_token;},tokenInvalidator:async(e,token)=>{tokenCache=null;await broker('invalidate',{access_token:token});},fetcher:(url,options)=>limited(env,url,options)});
 try{
  await stmt(SCHEMA).run();
  if(!(await stmt('PRAGMA table_info(vintage_stock_sync)').all()).results.some(x=>x.name==='applied_price'))await stmt('ALTER TABLE vintage_stock_sync ADD COLUMN applied_price INTEGER').run();
  await stmt('CREATE TABLE IF NOT EXISTS ml_pub_receipts (seller_id TEXT NOT NULL,isbn TEXT NOT NULL,state TEXT NOT NULL,item_id TEXT,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(seller_id,isbn))').run();
  // Publicaciones nuestras: recibos de la conexión (servidor) más los del motor local.
  const published=new Map();
  for(const r of c.receipts??[]){if(r.seller_id!==SELLER)throw new Error('foreign_seller_receipt');if(r.state==='published'&&r.item_id)published.set(r.isbn,r.item_id);}
  for(const r of (await stmt("SELECT isbn,item_id FROM ml_pub_receipts WHERE seller_id=? AND state='published' AND item_id IS NOT NULL",SELLER).all()).results)published.set(r.isbn,r.item_id);
  if(!published.size)return finish({state:'nothing_published',mode,feed_id:c.feed_id});
  const inStock=new Set(input.rows.filter(r=>hasSupplierStock(r.stock)).map(r=>r.isbn));
  const previous=new Map((await stmt('SELECT * FROM vintage_stock_sync').all()).results.map(r=>[r.isbn,r]));
  const rows=[...published].map(([isbn,item_id])=>({isbn,item_id}));
  const missing=rows.filter(r=>!inStock.has(r.isbn)).length,suspicious=missing*100>rows.length*maxMissingPct;
  const updates=[];
  for(const r of rows){
   const prev=previous.get(r.isbn);
   if(inStock.has(r.isbn)){updates.push({isbn:r.isbn,item_id:r.item_id,desired:'active',missing_since:0});continue;}
   if(suspicious){updates.push({isbn:r.isbn,item_id:r.item_id,desired:prev?.desired_status??null,missing_since:prev?.missing_since||0});continue;}
   const since=prev?.missing_since||feedTime;
   updates.push({isbn:r.isbn,item_id:r.item_id,desired:feedTime-since>=graceMs?'paused':(prev?.desired_status??null),missing_since:since});
  }
  for(const u of updates)await stmt('INSERT INTO vintage_stock_sync(isbn,item_id,desired_status,missing_since,feed_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(isbn) DO UPDATE SET item_id=excluded.item_id,desired_status=excluded.desired_status,missing_since=excluded.missing_since,feed_id=excluded.feed_id,updated_at=excluded.updated_at',u.isbn,u.item_id,u.desired,u.missing_since,c.feed_id,now()).run();
  const summary={state:'synced',mode,feed_id:c.feed_id,source_date:input.source_date,published:rows.length,in_stock:rows.length-missing,missing,suspicious_feed:suspicious,paused:0,activated:0,unchanged:0,skipped:0,errors:0};
  if(mode==='report')return finish({...summary,state:'report'});
  const wanted=mode==='pause_only'?['paused']:['paused','active'];
  const due=(await stmt(`SELECT * FROM vintage_stock_sync WHERE desired_status IN (${wanted.map(()=>'?').join(',')}) AND (applied_status IS NULL OR applied_status<>desired_status) AND next_at<=? ORDER BY updated_at,isbn LIMIT ?`,...wanted,now(),batch).all()).results;
  const applied=(row,status)=>stmt('UPDATE vintage_stock_sync SET applied_status=?,attempts=0,next_at=0,last_error=NULL,updated_at=? WHERE isbn=?',status,now(),row.isbn).run();
  const failed=(row,code,backoffMs)=>stmt('UPDATE vintage_stock_sync SET attempts=attempts+1,next_at=?,last_error=?,updated_at=? WHERE isbn=?',now()+Math.min(LONG_MS,backoffMs*2**Math.min(8,row.attempts)),code,now(),row.isbn).run();
  const deferAll=async(group,error)=>{for(const row of group)await failed(row,safeCode(error),Math.max(TRANSIENT_MS,(error.retryAfter||0)*1000));summary.errors+=group.length;};
  outer:for(let i=0;i<due.length;i+=20){
   const group=due.slice(i,i+20);
   let entries;
   try{entries=await api.call(env,bulkItemsPath(group.map(r=>r.item_id),ITEM_FIELDS));}
   catch(error){await deferAll(group,error);if(error.status===429){summary.state='backoff';break;}continue;}
   const bodies=new Map();
   if(Array.isArray(entries))for(const entry of entries){const item=bulkEntryItem(entry);if(item&&item.id)bodies.set(item.id,item);}
   for(const row of group){
    const item=bodies.get(row.item_id);
    if(!item){await failed(row,'item_unavailable',TRANSIENT_MS);summary.errors++;continue;}
    if(String(item.seller_id)!==SELLER||item.seller_custom_field!==`AMADO-AR-${row.isbn}`){await failed(row,'item_identity_mismatch',LONG_MS);summary.skipped++;continue;}
    if(!['active','paused'].includes(item.status)){await failed(row,`item_status_${/^[a-z_]{1,30}$/.test(String(item.status))?item.status:'unknown'}`,LONG_MS);summary.skipped++;continue;}
    const quantity=Number(item.available_quantity);
    if(item.status===row.desired_status&&(row.desired_status==='paused'||quantity>0)){await applied(row,item.status);summary.unchanged++;continue;}
    if(row.desired_status==='active'&&item.status==='paused'&&row.applied_status!=='paused'&&quantity!==0){await failed(row,'paused_externally',LONG_MS);summary.skipped++;continue;}
    const body=row.desired_status==='paused'?{status:'paused'}:{status:'active',available_quantity:1};
    try{await api.call(env,`/items/${row.item_id}`,{method:'PUT',body});}
    catch(error){
     if(error.status===429){await deferAll([row],error);summary.state='backoff';break outer;}
     await failed(row,safeCode(error),error instanceof MercadoLibreError&&error.status>=500?TRANSIENT_MS:3600000);summary.errors++;continue;
    }
    await applied(row,row.desired_status);summary[row.desired_status==='paused'?'paused':'activated']++;
    onStatus({isbn:row.isbn,item_id:row.item_id,applied:row.desired_status});
   }
  }
  if(mode==='pause_and_reactivate'&&summary.state!=='backoff'&&!suspicious)await reprice(summary);
  return finish(summary);

  // Precio: sólo los libros con stock hoy cuyo precio calculado difiere del último aplicado
  // (la primera vez, todos). Lee el precio real antes de cada PUT.
  async function reprice(summary){
   Object.assign(summary,{repriced:0,price_unchanged:0,price_skipped:0});
   const rowsByIsbn=new Map(input.rows.map(r=>[r.isbn,r]));
   const want=new Map();
   for(const r of rows){const row=rowsByIsbn.get(r.isbn);if(row&&hasSupplierStock(row.stock))want.set(r.isbn,quoteMercadoLibre(row,policy).price);}
   const state=new Map((await stmt('SELECT isbn,item_id,applied_price FROM vintage_stock_sync').all()).results.map(r=>[r.isbn,r]));
   const todo=[...want].filter(([isbn,price])=>state.get(isbn)?.applied_price!==price).map(([isbn,price])=>({isbn,price,item_id:state.get(isbn)?.item_id})).filter(x=>x.item_id);
   const setPrice=(isbn,price)=>stmt('UPDATE vintage_stock_sync SET applied_price=?,updated_at=? WHERE isbn=?',price,now(),isbn).run();
   for(let i=0;i<todo.length;i+=20){
    const group=todo.slice(i,i+20);
    let entries;
    try{entries=await api.call(env,bulkItemsPath(group.map(r=>r.item_id),ITEM_FIELDS));}
    catch(error){summary.errors+=group.length;if(error.status===429){summary.state='backoff';return;}continue;}
    const bodies=new Map();
    if(Array.isArray(entries))for(const entry of entries){const item=bulkEntryItem(entry);if(item&&item.id)bodies.set(item.id,item);}
    for(const r of group){
     const item=bodies.get(r.item_id);
     if(!item||String(item.seller_id)!==SELLER||item.seller_custom_field!==`AMADO-AR-${r.isbn}`||item.currency_id!=='UYU'||!['active','paused'].includes(item.status)){summary.price_skipped++;continue;}
     if(item.price===r.price){await setPrice(r.isbn,r.price);summary.price_unchanged++;continue;}
     const ratio=r.price/item.price;
     if(!(r.price>=1600)||!Number.isFinite(ratio)||ratio>MAX_PRICE_RATIO||ratio<1/MAX_PRICE_RATIO){summary.price_skipped++;onStatus({isbn:r.isbn,item_id:r.item_id,price_skipped:{from:item.price,to:r.price}});continue;}
     try{await api.call(env,`/items/${r.item_id}`,{method:'PUT',body:{price:r.price}});}
     catch(error){summary.errors++;if(error.status===429){summary.state='backoff';return;}continue;}
     await setPrice(r.isbn,r.price);summary.repriced++;
     onStatus({isbn:r.isbn,item_id:r.item_id,price:{from:item.price,to:r.price}});
    }
   }
  }
 }finally{db.close();}
 async function finish(summary){
  await fs.writeFile(path.join(directory,'stock-sync.json'),JSON.stringify({...summary,at:new Date(now()).toISOString()},null,2));
  onStatus(summary);return summary;
 }
}
async function main(){
 const args=process.argv.slice(2),get=name=>args.includes(name)?args[args.indexOf(name)+1]:undefined;
 try{
  const summary=await syncStock({connection:get('--connection'),excel:get('--excel'),directory:get('--directory'),mode:get('--mode')||'pause_and_reactivate',graceHours:Number(get('--grace-hours')??0),onStatus:x=>console.log(JSON.stringify(x))});
  if(summary.state==='backoff')process.exitCode=3;
 }catch(error){
  console.log(JSON.stringify({state:'failed',error:/^[a-z0-9_]{1,100}$/.test(error.code??error.message??'')?(error.code??error.message):'stock_sync_failed'}));
  process.exitCode=2;
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
