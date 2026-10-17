import test from 'node:test';
import assert from 'node:assert/strict';
import {onRequest as cover} from '../preview-cover/[[path]].js';
import {onRequest as ficha,renderPage} from '../libro/[[path]].js';
import {CATALOG_URL} from '../_shared/catalog.js';
const hash='a'.repeat(64), sum='b'.repeat(64), recipe='v1-240-q85', id='MLU123456789';
const path=[id,'0',hash+'.jpg'], bytes=new Uint8Array([82,73,70,70]);
const variantKey=`covers/variants/v1/${hash}/${recipe}.webp`;
function fixture(){
 const entries=new Map(),reads=[],puts=[];
 const cache={async match(key){return entries.get(key.url)?.clone();},async put(key,value){puts.push(key.url);entries.set(key.url,value.clone());}};
 globalThis.caches={default:cache};
 const env={APP_ENV:'production',COVER_R2_BUCKET_NAME:'amadolibros-images-production',IMAGE_VARIANTS_READ_ENABLED:'false',COVER_R2:{async get(key){reads.push(key);assert.equal(key,variantKey);return {body:bytes,size:bytes.length,httpMetadata:{contentType:'image/webp'},customMetadata:{master_sha256:hash,recipe,sha256:sum}};}}};
 const context=(method='GET',product=id)=>({env,params:{path:[product,...path.slice(1)]},request:new Request(`https://www.amadolibros.com/preview-cover/${product}/0/${hash}.jpg?variant=${recipe}`,{method})});
 return {env,context,entries,reads,puts,cache};
}
test.afterEach(()=>{delete globalThis.caches;});
test('flag off serves an existing immutable variant; GET cache reuses hash/recipe across product IDs',async()=>{
 const f=fixture(),a=await cover(f.context());assert.equal(a.status,200);assert.equal(a.headers.get('x-cover-source'),'r2-variant');assert.equal(a.headers.get('x-cover-cache'),'MISS');
 assert.deepEqual(new Uint8Array(await a.arrayBuffer()),bytes);
 f.env.IMAGE_VARIANTS_READ_ENABLED='true';const b=await cover(f.context('GET','MLU2'));assert.equal(b.headers.get('x-cover-cache'),'HIT');assert.deepEqual(new Uint8Array(await b.arrayBuffer()),bytes);
 assert.equal(f.reads.length,1);assert.equal(f.puts.length,1);
 f.env.IMAGE_VARIANTS_READ_ENABLED='false';const head=await cover(f.context('HEAD'));assert.equal(head.headers.get('x-cover-cache'),'HIT');assert.equal((await head.arrayBuffer()).byteLength,0);assert.equal(head.headers.get('content-length'),String(bytes.length));
});
test('HEAD miss caches full object without emptying subsequent GET',async()=>{
 const f=fixture(),head=await cover(f.context('HEAD'));assert.equal((await head.arrayBuffer()).byteLength,0);
 const get=await cover(f.context());assert.equal(get.headers.get('x-cover-cache'),'HIT');assert.deepEqual(new Uint8Array(await get.arrayBuffer()),bytes);assert.equal(f.reads.length,1);
});
test('missing, invalid metadata or R2 error redirects to equivalent transformation, never downloads master or caches fallback',async()=>{
 for(const mode of ['missing','mime','hash','error']){
  const f=fixture(),original=f.env.COVER_R2.get;
  f.env.COVER_R2.get=async key=>{if(mode==='error')throw Error('unavailable');const o=await original(key);if(mode==='missing')return null;if(mode==='mime')o.httpMetadata.contentType='image/jpeg';if(mode==='hash')o.customMetadata.master_sha256='c'.repeat(64);return o;};
  const r=await cover(f.context());assert.equal(r.status,302);
  const location=r.headers.get('location');assert.match(location,/^https:\/\/www\.amadolibros\.com\/cdn-cgi\/image\//);assert.match(location,/fit=scale-down,width=240,quality=85/);
  assert.ok(location.endsWith(`/preview-cover/${id}/0/${hash}.jpg`));assert.doesNotMatch(location,/variant=/);
  assert.equal(r.headers.get('x-cover-variant'),'legacy-transform-fallback');assert.match(r.headers.get('cache-control'),/max-age=60/);assert.equal(f.puts.length,0);assert.ok(f.reads.every(k=>k===variantKey));
 }
});
test('Preview missing variant never redirects to production or serves original',async()=>{
 const f=fixture();f.env.APP_ENV='preview';f.env.COVER_R2_BUCKET_NAME='amadolibros-images-preview';f.env.COVER_R2.get=async()=>null;
 const r=await cover(f.context());assert.equal(r.status,503);assert.equal(r.headers.get('location'),null);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(f.puts.length,0);
});
test('cache keys isolate bucket and environment, and ignore unrelated query parameters',async()=>{
 const f=fixture();await cover(f.context());
 const ctx=f.context();ctx.request=new Request(ctx.request.url+'&tracking=ignored');assert.equal((await cover(ctx)).headers.get('x-cover-cache'),'HIT');
 f.env.APP_ENV='preview';f.env.COVER_R2_BUCKET_NAME='amadolibros-images-preview';assert.equal((await cover(f.context())).headers.get('x-cover-cache'),'MISS');assert.equal(f.reads.length,2);
});
test('cache errors do not break validated R2 delivery',async()=>{
 const f=fixture();f.cache.match=async()=>{throw Error('cache');};f.cache.put=async()=>{throw Error('cache');};
 const r=await cover(f.context());assert.equal(r.status,200);assert.equal(r.headers.get('x-cover-source'),'r2-variant');
});
test('invalid recipe rejected before cache and R2',async()=>{
 const f=fixture(),ctx=f.context();ctx.request=new Request(ctx.request.url.replace(recipe,'bad'));
 assert.equal((await cover(ctx)).status,400);assert.equal(f.reads.length,0);assert.equal(f.puts.length,0);
});
test('real ficha handler keeps exact legacy transformation URLs with flag off/on, including secondary image and lazy zoom',async()=>{
 const savedFetch=globalThis.fetch;
 const item={id,title:'Libro de prueba',author:'Autora',price:100,status:'active',available_quantity:1,condition:'new',pictures:['https://http2.mlstatic.com/D_FIRST-O.jpg','https://http2.mlstatic.com/D_SECOND-O.jpg'],thumbnail:'',permalink:'https://example.com/item'};
 const preview=`https://www.amadolibros.com/preview-cover/${id}/0/${hash}.jpg`;
 const urls=s=>(s.match(/https:\/\/www\.amadolibros\.com\/cdn-cgi\/image\/[^"'<>\\\s]+/g)||[]).sort();
 try{
  globalThis.fetch=async()=>Response.json({});
  globalThis.caches={default:{async match(key){return key.url===CATALOG_URL?Response.json({items:[item]}):null;},async put(){}}};
  const expected=urls(renderPage(item,'libro-de-prueba',false,'',preview));assert.ok(expected.length>0);
  for(const flag of ['false','true']){
   const env={APP_ENV:'production',IMAGE_VARIANTS_READ_ENABLED:flag,COVER_R2:{async get(){return {text:async()=>JSON.stringify({schema_version:1,entries:{[id+':0']:{product_id:id,position:0,current:{object_key:`covers/v1/objects/${hash}.jpg`,sha256:hash,mime:'image/jpeg',source_url:item.pictures[0]}}}})};}}};
   const r=await ficha({request:new Request(`https://www.amadolibros.com/libro/${id}/libro-de-prueba`),params:{path:[id,'libro-de-prueba']},env,data:{},waitUntil(){}});
   assert.equal(r.status,200);const html=await r.text();assert.deepEqual(urls(html),expected);assert.doesNotMatch(html,/\/preview-cover\/|[?&]variant=/);
   const zoom=html.match(/<img[^>]*id="glbImg"[^>]*>/)?.[0];assert.ok(zoom);assert.doesNotMatch(zoom,/\s(?:src|srcset)=/);
   assert.ok(html.includes(`/book-cover/${id}/cover-2.jpg`));
  }
 }finally{globalThis.fetch=savedFetch;}
});
