// Pausa en Mercado Libre las publicaciones de Vintage cuyo ISBN dejó de figurar (o quedó sin
// disponibilidad) en el Excel vigente de SBS, y reactiva las que nosotros pausamos cuando vuelven.
//
// Modelo: worker-sync/publication-stock-sync.js (Amado Libros), que NO se usa ni se modifica.
// Este módulo opera solo sobre el seller de Vintage y sobre la base SQLite local del publicador.
//
//  - En el Excel de SBS un libro agotado simplemente desaparece (Disponibilidad solo vale +2, 2 o 1).
//  - Un archivo vencido, incompleto o más viejo que el último sincronizado nunca pausa nada.
//  - Si desaparece un porcentaje alto de lo publicado de una vez, no se pausa nada: se informa.
//  - Solo se toca un ítem del seller 2341378249 con SKU AMADO-AR-<ISBN>. Nunca se cierra nada.
//  - Una pausa hecha a mano o por Mercado Libre se respeta: solo se reactiva lo que pausó este proceso
//    o lo que quedó en cantidad 0.
import {bulkItemsPath,bulkEntryItem} from '../../worker-sync/meli-bulk.js';
import {PublicationError,hasSupplierStock,stockIsFresh,safeCode} from '../../worker-sync/publication-policy.js';
import {MercadoLibreError} from '../../worker-sync/publication-meli.js';

export const SELLER='2341378249';
export const STOCK_SYNC_MODES=['report','pause_only','pause_and_reactivate'];
export const MIN_WORKBOOK_ROWS=40000,MIN_PUBLISHED_FOR_GUARD=20;
const ITEM_FIELDS='id,seller_id,status,available_quantity,seller_custom_field';
const TRANSIENT_BACKOFF_MS=300000,LONG_BACKOFF_MS=86400000,SAMPLE=200;
export const SCHEMA='CREATE TABLE IF NOT EXISTS ml_vintage_stock_sync (isbn TEXT PRIMARY KEY,item_id TEXT NOT NULL,desired_status TEXT,applied_status TEXT,missing_since INTEGER NOT NULL DEFAULT 0,in_stock_at INTEGER NOT NULL DEFAULT 0,feed_date TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,last_error TEXT,updated_at INTEGER NOT NULL DEFAULT 0)';
const UPSERT='INSERT INTO ml_vintage_stock_sync(isbn,item_id,desired_status,missing_since,in_stock_at,feed_date,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(isbn) DO UPDATE SET item_id=excluded.item_id,desired_status=excluded.desired_status,missing_since=excluded.missing_since,in_stock_at=excluded.in_stock_at,feed_date=excluded.feed_date,updated_at=excluded.updated_at';

export async function syncStock({db,api,env,rows,sourceDate,mode='report',graceHours=0,maxMissingPct=10,batch=500,now=Date.now}){
 if(!STOCK_SYNC_MODES.includes(mode))throw new PublicationError('invalid_stock_sync_mode',400);
 const startedAt=now();
 if(!stockIsFresh(sourceDate,startedAt))return {state:'feed_stale'};
 if(!Array.isArray(rows)||rows.length<MIN_WORKBOOK_ROWS)return {state:'workbook_incomplete',rows:Array.isArray(rows)?rows.length:0};
 await db.prepare(SCHEMA).run();
 const feedTime=Date.parse(sourceDate),feedIso=new Date(feedTime).toISOString(); // UTC text sorts correctly
 const last=(await db.prepare('SELECT MAX(feed_date) m FROM ml_vintage_stock_sync').first())?.m;
 if(last&&feedTime<Date.parse(last))return {state:'older_than_last_sync',last_sync_feed:last};
 const published=(await db.prepare("SELECT isbn,item_id FROM ml_vintage_pub_receipts WHERE seller_id=? AND state='published' AND item_id IS NOT NULL ORDER BY isbn").bind(SELLER).all()).results;
 if(!published.length)return {state:'nothing_published'};
 const stock=new Map(rows.map(r=>[r.isbn,r.stock])),previous=new Map((await db.prepare('SELECT * FROM ml_vintage_stock_sync').all()).results.map(r=>[r.isbn,r]));
 const inStock=new Set(published.filter(r=>hasSupplierStock(stock.get(r.isbn))).map(r=>r.isbn)),missing=published.length-inStock.size;
 // A mass disappearance looks like a broken file, not like sell-outs: report it, pause nothing.
 const suspicious=published.length>=MIN_PUBLISHED_FOR_GUARD&&missing*100>published.length*maxMissingPct,graceMs=graceHours*3600000,updates=[];
 for(const r of published){
  const prev=previous.get(r.isbn);
  if(inStock.has(r.isbn)){updates.push([r.isbn,r.item_id,'active',0,feedTime]);continue;}
  if(suspicious)continue;
  const since=prev?.missing_since||feedTime;
  updates.push([r.isbn,r.item_id,feedTime-since>=graceMs?'paused':(prev?.desired_status??null),since,prev?.in_stock_at??0]);
 }
 for(let i=0;i<updates.length;i+=200)await db.batch(updates.slice(i,i+200).map(u=>db.prepare(UPSERT).bind(...u,feedIso,startedAt)));
 const summary={state:'synced',mode,feed_date:sourceDate,published:published.length,missing,suspicious_feed:suspicious,paused:0,activated:0,unchanged:0,skipped:0,errors:0,paused_isbns:[],activated_isbns:[],skipped_by_reason:{}};
 const wanted=mode==='pause_only'?['paused']:['paused','active'];
 const dueSql=`SELECT * FROM ml_vintage_stock_sync WHERE desired_status IN (${wanted.map(()=>'?').join(',')}) AND (applied_status IS NULL OR applied_status<>desired_status) AND next_at<=? ORDER BY CASE desired_status WHEN 'paused' THEN 0 ELSE 1 END,updated_at,isbn LIMIT ?`; // pauses first: a sold-out book must not wait behind the baseline check of the rest
 if(mode==='report'){
  const pending=(await db.prepare("SELECT isbn,item_id FROM ml_vintage_stock_sync WHERE desired_status='paused' AND (applied_status IS NULL OR applied_status<>'paused') ORDER BY isbn").all()).results;
  return {...summary,state:'reported',would_pause:pending.length,would_pause_isbns:pending.slice(0,SAMPLE).map(r=>r.isbn)};
 }
 const due=(await db.prepare(dueSql).bind(...wanted,startedAt,batch).all()).results;
 const applied=(row,status)=>db.prepare('UPDATE ml_vintage_stock_sync SET applied_status=?,attempts=0,next_at=0,last_error=NULL,updated_at=? WHERE isbn=?').bind(status,now(),row.isbn).run();
 const failed=(row,code,backoffMs)=>db.prepare('UPDATE ml_vintage_stock_sync SET attempts=attempts+1,next_at=?,last_error=?,updated_at=? WHERE isbn=?').bind(now()+Math.min(LONG_BACKOFF_MS,backoffMs*2**Math.min(8,row.attempts)),code,now(),row.isbn).run();
 const skip=async(row,code,backoff)=>{await failed(row,code,backoff);summary.skipped++;summary.skipped_by_reason[code]=(summary.skipped_by_reason[code]??0)+1;};
 const deferAll=async(group,error)=>{for(const row of group)await failed(row,safeCode(error),Math.max(TRANSIENT_BACKOFF_MS,(error.retryAfter||0)*1000));summary.errors+=group.length;};
 outer:for(let i=0;i<due.length;i+=20){
  const group=due.slice(i,i+20);
  let entries;
  try{entries=await api.call(env,bulkItemsPath(group.map(r=>r.item_id),ITEM_FIELDS));}
  catch(error){await deferAll(group,error);if(error.status===429){summary.state='backoff';break;}continue;}
  const bodies=new Map();
  if(Array.isArray(entries))for(const entry of entries){const item=bulkEntryItem(entry);if(item&&item.id)bodies.set(item.id,item);}
  for(const row of group){
   const item=bodies.get(row.item_id);
   if(!item){await failed(row,'item_unavailable',TRANSIENT_BACKOFF_MS);summary.errors++;continue;}
   if(String(item.seller_id)!==SELLER||item.seller_custom_field!==`AMADO-AR-${row.isbn}`){await skip(row,'item_identity_mismatch',LONG_BACKOFF_MS);continue;}
   if(!['active','paused'].includes(item.status)){await skip(row,`item_status_${/^[a-z_]{1,30}$/.test(String(item.status))?item.status:'unknown'}`,LONG_BACKOFF_MS);continue;}
   const quantity=Number(item.available_quantity);
   if(item.status===row.desired_status&&(row.desired_status==='paused'||quantity>0)){await applied(row,item.status);summary.unchanged++;continue;}
   if(row.desired_status==='active'&&row.applied_status!=='paused'&&!(item.status==='paused'&&quantity===0)&&item.status==='paused'){await skip(row,'paused_externally',LONG_BACKOFF_MS);continue;}
   const body=row.desired_status==='paused'?{status:'paused'}:{status:'active',available_quantity:1};
   try{await api.call(env,`/items/${row.item_id}`,{method:'PUT',body});}
   catch(error){
    if(error.status===429){await deferAll([row],error);summary.state='backoff';break outer;}
    await failed(row,safeCode(error),error instanceof MercadoLibreError&&error.status>=500?TRANSIENT_BACKOFF_MS:3600000);summary.errors++;continue;
   }
   await applied(row,row.desired_status);
   if(row.desired_status==='paused'){summary.paused++;if(summary.paused_isbns.length<SAMPLE)summary.paused_isbns.push(row.isbn);}
   else{summary.activated++;if(summary.activated_isbns.length<SAMPLE)summary.activated_isbns.push(row.isbn);}
  }
 }
 return summary;
}
