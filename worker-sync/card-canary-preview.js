import {onRequest as catalog} from '../functions/catalogo.js';
import {onRequest as ficha} from '../functions/libro/[[path]].js';
import {onRequest as immutable} from '../functions/preview-cover/[[path]].js';
// Isolated acceptance harness: no payments, no writable bucket interface.
export default {async fetch(request,env,execution){
 if(!env.INCIDENT_TOKEN||request.headers.get('authorization')!==`Bearer ${env.INCIDENT_TOKEN}`||request.method!=='GET')return new Response('Forbidden',{status:403});
 const u=new URL(request.url),bucket=env.PRODUCTION_COVERS_READONLY;
 if(u.pathname==='/ready')return Response.json({head:env.INCIDENT_BUILD_SHA});
 if(u.pathname==='/manifest'){const o=await bucket.get('covers/v1/manifest.json');return new Response(o.body,{headers:{'content-type':'application/json','x-snapshot-etag':o.etag}});}
 if(u.pathname==='/readiness'){const o=await bucket.get('covers/card-readiness/v1/fdc59f13a42150ac77cd6cb5c700bc0b963eed3efc48259891ef77f32a49adcf.json');return new Response(o?.body||null,{status:o?200:404});}
 if(u.pathname==='/inventory'){
  const prefix=u.searchParams.get('prefix');
  if(!['covers/v1/objects/','covers/variants/v1/'].includes(prefix))return new Response('Invalid prefix',{status:400});
  return Response.json(await bucket.list({prefix,cursor:u.searchParams.get('cursor')||undefined,limit:1000,include:['customMetadata','httpMetadata']}));
 }
 const ids=request.headers.get('x-canary-ids')||'';
 if(!ids||ids.split(',').length!==10||!ids.split(',').every(id=>/^MLU\d+$/.test(id)))return new Response('Ten IDs required',{status:400});
 const synthetic=new URL(u.pathname+u.search,'https://card-canary.amadolibros-web.pages.dev');
 const ctx={request:new Request(synthetic),data:{},params:{},waitUntil:p=>execution.waitUntil(p),env:{APP_ENV:'production',COVER_R2:{get:key=>bucket.get(key),head:key=>key==='covers/v1/manifest.json'?bucket.head(key):null},COVER_R2_BUCKET_NAME:'amadolibros-images-production',IMAGE_VARIANTS_READ_ENABLED:u.searchParams.has('_canary_off')?'false':'true',CARD_VARIANTS_INDEX_SHA256:'fdc59f13a42150ac77cd6cb5c700bc0b963eed3efc48259891ef77f32a49adcf',CARD_VARIANTS_CANARY_IDS:ids}};
 let r;
 if(u.pathname==='/catalogo')r=await catalog(ctx);
 else if(u.pathname.startsWith('/libro/')){ctx.params.path=u.pathname.slice(7).split('/');r=await ficha(ctx);}
 else if(u.pathname.startsWith('/preview-cover/')){ctx.params.path=u.pathname.slice(15).split('/');r=await immutable(ctx);}
 else return new Response('Not found',{status:404});
 const h=new Headers(r.headers);h.set('x-canary-build',env.INCIDENT_BUILD_SHA);h.set('x-robots-tag','noindex, nofollow');
 return new Response(r.body,{status:r.status,headers:h});
}};
