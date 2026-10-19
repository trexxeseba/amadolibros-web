import {MercadoLibreError} from '../../worker-sync/publication-meli.js';

// These are our budgets, not published Mercado Libre quotas. Keep the global 2 s clock.
export const GLOBAL_INTERVAL_MS=2000,PRODUCT_SEARCH_INTERVAL_MS=5000;
export const ENDPOINT_RATE_SCHEMA="CREATE TABLE IF NOT EXISTS ml_vintage_bulk_endpoint_rate (endpoint TEXT PRIMARY KEY,next_at INTEGER NOT NULL DEFAULT 0,cooldown INTEGER NOT NULL DEFAULT 0,strikes INTEGER NOT NULL DEFAULT 0)";
const API_ORIGIN='https://api.mercadolibre.com';

// A closed vocabulary: query strings, ISBNs, seller ids and arbitrary paths never reach telemetry.
export function requestEndpoint(input){
 const {pathname:p}=new URL(input);
 if(['/users/me','/items','/items/validate','/items/bulk','/products/search','/sites/MLU/listing_prices','/sites/MLU/domain_discovery/search'].includes(p))return p;
 if(/^\/items\/MLU\d+$/.test(p))return '/items/MLU#';
 if(/^\/products\/MLU\d+$/.test(p))return '/products/MLU#';
 if(/^\/categories\/MLU\d+(?:\/attributes)?$/.test(p))return p.endsWith('/attributes')?'/categories/MLU#/attributes':'/categories/MLU#';
 if(/^\/catalog_domains\/MLU-[A-Z_]+\/categories$/.test(p))return '/catalog_domains/#/categories';
 if(/^\/users\/\d+\/(items\/search|shipping_preferences)$/.test(p))return p.endsWith('/items/search')?'/users/#/items/search':'/users/#/shipping_preferences';
 return '/other';
}
function cacheTtl(url,method){
 if(method!=='GET'||url.origin!==API_ORIGIN||url.searchParams.has('access_token'))return 0;
 if(/^\/categories\/MLU\d+(?:\/attributes)?$/.test(url.pathname)||/^\/catalog_domains\/MLU-[A-Z_]+\/categories$/.test(url.pathname))return 1800000;
 // A short, positive-only cache helps retries; unique new ISBNs still require their own search.
 if(url.pathname==='/products/search'&&url.searchParams.get('site_id')==='MLU'&&url.searchParams.get('status')==='active'&&/^(978|979)\d{10}$/.test(url.searchParams.get('product_identifier')??'')&&[...url.searchParams.keys()].every(k=>['site_id','status','product_identifier'].includes(k)))return 300000;
 if(/^\/products\/MLU\d+$/.test(url.pathname)&&!url.search)return 300000;
 return 0;
}
function cacheableBody(url,body){
 if(url.pathname==='/products/search')return Array.isArray(body?.results)&&body.results.length===1&&(body.paging?.total===undefined||body.paging.total===1)&&/^MLU\d+$/.test(body.results[0]?.id??'');
 if(/^\/products\/MLU\d+$/.test(url.pathname))return body?.id===url.pathname.slice('/products/'.length)&&body.status==='active'&&body.domain_id==='MLU-BOOKS';
 return true;
}
export function createVintageBulkFetch({fetcher=(...args)=>fetch(...args),now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),random=Math.random,onEvent=()=>{}}={}){
 let tail=Promise.resolve();
 const emit=event=>{try{onEvent(event);}catch{/* Diagnostics cannot change the result of a create. */}};
 return (env,url,options={})=>{
  const task=tail.then(async()=>{
   const parsed=new URL(url);
   // The supplier fallback also uses this fetcher. It is not part of the ML request budget.
   if(parsed.origin!==API_ORIGIN)return fetcher(url,options);
   const db=env.ORDERS_DB,method=(options.method??'GET').toUpperCase(),endpoint=requestEndpoint(url),key=method+' '+endpoint,ttl=cacheTtl(parsed,method);
   if(ttl){
    const cached=await db.prepare('SELECT response_json FROM ml_vintage_bulk_cache WHERE url=? AND expires_at>?').bind(url,now()).first();
    if(cached){emit({kind:'cache_hit',at:now(),method,endpoint});return new Response(cached.response_json,{headers:{'Content-Type':'application/json'}});}
   }
   await db.prepare('INSERT OR IGNORE INTO ml_vintage_bulk_endpoint_rate(endpoint) VALUES(?)').bind(key).run();
   const rate=await db.prepare('SELECT * FROM ml_vintage_bulk_rate WHERE id=1').first(),resource=await db.prepare('SELECT * FROM ml_vintage_bulk_endpoint_rate WHERE endpoint=?').bind(key).first();
   const blockedUntil=Math.max(rate.cooldown,resource.cooldown);
   if(blockedUntil>now())throw new MercadoLibreError('vintage_rate_cooldown',429,Math.ceil((blockedUntil-now())/1000));
   const interval=endpoint==='/products/search'?PRODUCT_SEARCH_INTERVAL_MS:GLOBAL_INTERVAL_MS,time=now();
   // Both clocks are reserved in one transaction, including across isolates sharing this DB.
   const reservations=await db.batch([
    db.prepare('UPDATE ml_vintage_bulk_endpoint_rate SET next_at=MAX(next_at,(SELECT next_at FROM ml_vintage_bulk_rate WHERE id=1),?)+? WHERE endpoint=? AND cooldown<=? AND (SELECT cooldown FROM ml_vintage_bulk_rate WHERE id=1)<=? RETURNING next_at').bind(time,interval,key,time,time),
    db.prepare('UPDATE ml_vintage_bulk_rate SET next_at=MAX(next_at,(SELECT next_at FROM ml_vintage_bulk_endpoint_rate WHERE endpoint=?)-?)+? WHERE id=1 AND cooldown<=? AND (SELECT cooldown FROM ml_vintage_bulk_endpoint_rate WHERE endpoint=?)<=? RETURNING next_at').bind(key,interval,GLOBAL_INTERVAL_MS,time,key,time),
   ]);
   const slot=reservations[0].results?.[0];
   if(!slot||!reservations[1].results?.length)throw new MercadoLibreError('vintage_rate_cooldown',429,120);
   const wait=slot.next_at-interval-now();
   if(wait>30000)throw new MercadoLibreError('vintage_rate_budget',429,Math.ceil(wait/1000));
   if(wait>0)await sleep(wait);
   const again=await db.prepare('SELECT MAX(cooldown,(SELECT cooldown FROM ml_vintage_bulk_endpoint_rate WHERE endpoint=?)) cooldown FROM ml_vintage_bulk_rate WHERE id=1').bind(key).first();
   if(again.cooldown>now())throw new MercadoLibreError('vintage_rate_cooldown',429,Math.ceil((again.cooldown-now())/1000));
   const started=now();let response;
   try{response=await fetcher(url,options);}catch(error){emit({kind:'request',at:started,method,endpoint,status:0,duration_ms:Math.max(0,now()-started)});throw error;}
   emit({kind:'request',at:started,method,endpoint,status:response.status,duration_ms:Math.max(0,now()-started),retry_after:response.status===429?response.headers.get('retry-after'):null});
   if(response.ok&&resource.strikes>0){
    // Only a success on this method/endpoint resets this endpoint's strikes.
    await db.prepare('UPDATE ml_vintage_bulk_endpoint_rate SET strikes=0 WHERE endpoint=? AND cooldown<=?').bind(key,now()).run();
    await db.prepare('UPDATE ml_vintage_bulk_rate SET strikes=(SELECT COALESCE(MAX(strikes),0) FROM ml_vintage_bulk_endpoint_rate) WHERE id=1').run();
   }
   if(ttl&&response.ok){try{
    const text=await response.clone().text();
    if(text.length<=524288&&cacheableBody(parsed,JSON.parse(text)))await db.prepare('INSERT INTO ml_vintage_bulk_cache(url,expires_at,response_json) VALUES(?,?,?) ON CONFLICT(url) DO UPDATE SET expires_at=excluded.expires_at,response_json=excluded.response_json').bind(url,now()+ttl,text).run();
   }catch{/* An invalid/unavailable cache never changes the API result. */}}
   if(response.status===429){
    const header=response.headers.get('retry-after'),seconds=Number(header),serverWait=Number.isFinite(seconds)?seconds*1000:Math.max(0,Date.parse(header)-now())||0;
    const until=now()+Math.max(serverWait,Math.min(3600000,120000*2**Math.min(resource.strikes,5)))+Math.floor(random()*15000);
    await db.batch([
     db.prepare('UPDATE ml_vintage_bulk_endpoint_rate SET cooldown=MAX(cooldown,?),strikes=MIN(strikes+1,6) WHERE endpoint=?').bind(until,key),
     db.prepare('UPDATE ml_vintage_bulk_rate SET cooldown=MAX(cooldown,?),strikes=(SELECT COALESCE(MAX(strikes),0) FROM ml_vintage_bulk_endpoint_rate) WHERE id=1').bind(until),
    ]);
   }
   return response;
  });
  tail=task.catch(()=>{});return task;
 };
}
