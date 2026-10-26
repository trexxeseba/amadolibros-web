import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readyCardVariantSource as selectSource, CARD_RECIPES, PRODUCTION_IMAGE_BUCKET, cardCanaryRequest } from '../_shared/card-variant-delivery.js';

function readyCardVariantSource(ctx,item) { return selectSource(ctx,item,`https://www.amadolibros.com/preview-cover/${item.id}/0/${'a'.repeat(64)}.jpg`); }
function fixture() {
  const hash='a'.repeat(64), source='https://http2.mlstatic.com/D_TEST-O.jpg';
  const index={schema:'verified-card-readiness-v1',bucket:PRODUCTION_IMAGE_BUCKET,recipes:CARD_RECIPES,
    cards:{MLU1:{sha256:hash,extension:'jpg',source_url:'http://http2.mlstatic.com/D_TEST-I.jpg#old'}}};
  let text=JSON.stringify(index), gets=0;
  const digest=createHash('sha256').update(text).digest('hex');
  const bucket={async get(key){gets++;assert.equal(key,`covers/card-readiness/v1/${digest}.json`);return {size:Buffer.byteLength(text),text:async()=>text};},
    head(){throw new Error('HEAD forbidden');}};
  const ctx={request:new Request('https://www.amadolibros.com/catalogo?_card_variants=1'),env:{APP_ENV:'production',
    IMAGE_VARIANTS_READ_ENABLED:'true',CARD_VARIANTS_CANARY_IDS:'MLU1',CARD_VARIANTS_INDEX_SHA256:digest,
    COVER_R2:bucket,COVER_R2_BUCKET_NAME:PRODUCTION_IMAGE_BUCKET},data:{}};
  return {ctx,index,item:{id:'MLU1',status:'active',available_quantity:1,pictures:[source]},get gets(){return gets;},tamper(){text+=' ';}};
}

test('48 selections share one GET, zero HEAD; next request reuses immutable verified index',async()=>{
  const f=fixture();
  const result=await Promise.all(Array.from({length:48},()=>readyCardVariantSource(f.ctx,f.item)));
  assert.ok(result.every(Boolean));assert.equal(f.gets,1);
  f.ctx.data={};assert.ok(await readyCardVariantSource(f.ctx,f.item));assert.equal(f.gets,1);
});
test('normal traffic, disabled, wrong bucket, preview, paused, no stock, enlarged, unselected do no reads',async()=>{
  for(const change of [f=>f.ctx.request=new Request('https://www.amadolibros.com/catalogo'),
    f=>f.ctx.env.IMAGE_VARIANTS_READ_ENABLED='false',f=>f.ctx.env.COVER_R2_BUCKET_NAME='amadolibros-images-preview',
    f=>f.ctx.env.APP_ENV='preview',f=>f.item.status='paused',f=>f.item.available_quantity=0,
    f=>delete f.item.pictures,f=>f.item.id='MLU697305757',f=>f.ctx.env.CARD_VARIANTS_CANARY_IDS='MLU2',
    f=>f.ctx.env.CARD_VARIANTS_CANARY_IDS=Array.from({length:11},(_,i)=>'MLU'+i).join(',')]) {
    const f=fixture();change(f);assert.equal(await readyCardVariantSource(f.ctx,f.item),null);assert.equal(f.gets,0);
  }
});
test('missing pin, tampered bytes, missing index, errors, drift preserve previous delivery',async()=>{
  for(const change of [f=>delete f.ctx.env.CARD_VARIANTS_INDEX_SHA256,f=>f.tamper(),
    f=>f.ctx.env.COVER_R2.get=async()=>null,f=>f.ctx.env.COVER_R2.get=async()=>{throw new Error('R2 unavailable');},
    f=>f.item.pictures=['https://http2.mlstatic.com/changed-O.jpg']]) {
    const f=fixture();change(f);assert.equal(await readyCardVariantSource(f.ctx,f.item),null);
  }
});
test('hung readiness lookup returns legacy within bounded time and never poisons cache',async()=>{
  const f=fixture(), original=f.ctx.env.COVER_R2.get;
  f.ctx.env.COVER_R2.get=()=>new Promise(()=>{});
  const start=performance.now();assert.equal(await readyCardVariantSource(f.ctx,f.item),null);
  assert.ok(performance.now()-start<1000);
  f.ctx.data={};f.ctx.env.COVER_R2.get=original;assert.ok(await readyCardVariantSource(f.ctx,f.item));
});
test('explicit canary marker required independently of read flag',()=>{
  const f=fixture();assert.equal(cardCanaryRequest(f.ctx),true);
  f.ctx.request=new Request('https://www.amadolibros.com/catalogo');assert.equal(cardCanaryRequest(f.ctx),false);
});

test('same source with newer current master hash cannot select stale readiness',async()=>{
  const f=fixture();
  assert.equal(await selectSource(f.ctx,f.item,`https://www.amadolibros.com/preview-cover/MLU1/0/${'c'.repeat(64)}.jpg`),null);
  assert.equal(await selectSource(f.ctx,f.item,null),null);
});

test('compact search primary source is verified against readiness and current hash',async()=>{
  const f=fixture();f.item.thumbnail=f.item.pictures[0];delete f.item.pictures;
  assert.ok(await readyCardVariantSource(f.ctx,f.item));
  f.item.thumbnail='https://http2.mlstatic.com/CHANGED-O.jpg';
  assert.equal(await readyCardVariantSource(f.ctx,f.item),null);
  f.item.thumbnail='https://http2.mlstatic.com/D_TEST-O.jpg';
  assert.equal(await selectSource(f.ctx,f.item,`/preview-cover/MLU1/0/${'c'.repeat(64)}.jpg`),null);
  f.item.pictures=[];
  assert.equal(await readyCardVariantSource(f.ctx,f.item),null,'full records never substitute a thumbnail for an absent primary');
});
