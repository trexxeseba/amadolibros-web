const USER = 'radar';
const PASSWORD_SHA256 = 'c71c8b17fa29a0e65af9eba67a744dc7d7b5099543300ff88821d30dd3de8983';
const API_ORIGIN = 'https://radar-api-amadolibros-sync.undiaes.workers.dev';
const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const CATALOG_CACHE_MS = 5 * 60 * 1000;
let catalogCache = { loadedAt: 0, byId: null, updatedAt: null };

async function sha256Hex(value){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
}

async function authorized(request){
  const header=request.headers.get('Authorization')||'';
  if(!header.startsWith('Basic ')) return false;
  try{
    const decoded=atob(header.slice(6));
    const i=decoded.indexOf(':');
    if(i<0) return false;
    const user=decoded.slice(0,i), pass=decoded.slice(i+1);
    return user===USER && await sha256Hex(pass)===PASSWORD_SHA256;
  }catch{return false}
}

function denied(){
  return new Response('Radar Amado — acceso privado',{status:401,headers:{'WWW-Authenticate':'Basic realm="Radar Amado"','Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive'}});
}

async function getCatalogIndex(){
  const now=Date.now();
  if(catalogCache.byId && now-catalogCache.loadedAt<CATALOG_CACHE_MS) return catalogCache;
  const response=await fetch(CATALOG_URL,{headers:{Accept:'application/json'}});
  if(!response.ok) throw new Error(`Catálogo HTTP ${response.status}`);
  const catalog=await response.json();
  const byId=new Map();
  for(const item of catalog.items||[]){
    if(!item?.id) continue;
    byId.set(String(item.id),{
      title:item.title||null,
      author:item.author||null,
      isbn:item.isbn||null,
      stock:Number.isFinite(Number(item.available_quantity))?Number(item.available_quantity):null,
      price:Number.isFinite(Number(item.price))?Number(item.price):null,
      currency:item.currency||'UYU',
      status:item.status||null,
      permalink:item.permalink||null,
      catalog_product_id:item.catalog_product_id||null,
    });
  }
  catalogCache={loadedAt:now,byId,updatedAt:catalog.updated_at||null};
  return catalogCache;
}

async function enrichSalesResponse(response){
  const data=await response.json().catch(()=>({}));
  if(!response.ok) return new Response(JSON.stringify(data),{status:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive'}});
  try{
    const catalog=await getCatalogIndex();
    data.sample=(data.sample||[]).map(row=>({
      ...row,
      ...(catalog.byId.get(String(row.item_id))||{}),
    }));
    data.catalog_updated_at=catalog.updatedAt;
    data.catalog_enriched=true;
  }catch(error){
    data.catalog_enriched=false;
    data.catalog_error=String(error?.message||'No se pudo leer catálogo').slice(0,160);
  }
  return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive'}});
}

export default {
  async fetch(request,env){
    if(!await authorized(request)) return denied();
    const url=new URL(request.url);
    if(url.pathname==='/api/sales' || url.pathname==='/api/competition'){
      const upstream=new URL(url.pathname==='/api/sales'?'/dashboard/sales':'/dashboard/competition',API_ORIGIN);
      for(const [k,v] of url.searchParams) upstream.searchParams.append(k,v);
      const response=await fetch(upstream,{headers:{Authorization:request.headers.get('Authorization')||''}});
      if(url.pathname==='/api/sales') return enrichSalesResponse(response);
      return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('Content-Type')||'application/json','Cache-Control':'no-store','X-Robots-Tag':'noindex, noarchive'}});
    }
    const response=await env.ASSETS.fetch(request);
    const headers=new Headers(response.headers);
    headers.set('X-Robots-Tag','noindex, nofollow, noarchive');
    headers.set('Cache-Control','private, no-store');
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  }
};
