import test from 'node:test';
import assert from 'node:assert/strict';
import { readyCardVariantSource, CARD_RECIPES, PRODUCTION_IMAGE_BUCKET } from '../_shared/card-variant-delivery.js';
import { findPreviewCover } from '../_shared/preview-cover.js';
import { prepareCoverIndex, COVER_INDEX_METADATA } from '../_shared/cover-public-index.js';
import { responsiveImage } from '../_shared/cloudflare-images.js';

async function fixture() {
  const hash='a'.repeat(64), source='https://http2.mlstatic.com/D_TEST-O.jpg';
  const manifest={schema_version:1,entries:{'MLU1:0':{product_id:'MLU1',position:0,current:{
    object_key:`covers/v1/objects/${hash}.jpg`,sha256:hash,mime:'image/jpeg',source_url:'http://http2.mlstatic.com/D_TEST-I.jpg#old'}}}};
  const objects=new Map(), variants=new Map();let heads=0;
  const bucket={
    async put(key,text){objects.set(key,text);return {};},
    async get(key){const text=objects.get(key);return text?{size:Buffer.byteLength(text),text:async()=>text}:null;},
    async head(key){heads++;if(key==='covers/v1/manifest.json')return {customMetadata:{[COVER_INDEX_METADATA]:root.hash}};return variants.get(key)||null;}
  };
  const root=await prepareCoverIndex(bucket,manifest);
  for(const recipe of CARD_RECIPES) variants.set(`covers/variants/v1/${hash}/${recipe}.webp`,{
    size:100,httpMetadata:{contentType:'image/webp'},customMetadata:{master_sha256:hash,recipe,sha256:'b'.repeat(64)}});
  const ctx={request:new Request('https://www.amadolibros.com/catalogo'),env:{APP_ENV:'production',
    IMAGE_VARIANTS_READ_ENABLED:'true',COVER_R2:bucket,COVER_R2_BUCKET_NAME:PRODUCTION_IMAGE_BUCKET},data:{}};
  const item={id:'MLU1',status:'active',available_quantity:1,pictures:[source]};
  return {ctx,item,variants,objects,hash,get heads(){return heads;}};
}

test('real resolver normalizes both stored and catalog URLs; complete variants emit three permanent card URLs',async()=>{
  const f=await fixture();
  const cover=await findPreviewCover(f.ctx,'MLU1',0,f.item.pictures[0]);assert.equal(cover.sha256,f.hash);
  const source=await readyCardVariantSource(f.ctx,f.item);assert.ok(source);
  const image=responsiveImage(source,{widths:[240,360,480],defaultWidth:360,permanent:true});
  assert.equal((image.srcset.match(/variant=v1-/g)||[]).length,3);
  assert.doesNotMatch(image.srcset,/cdn-cgi/);assert.equal(f.ctx.data.coverIndex.mode,'public-index');
});

test('disabled, wrong bucket, preview, paused, missing source and enlarged cards perform no variant selection',async()=>{
  for(const change of [f=>f.ctx.env.IMAGE_VARIANTS_READ_ENABLED='false',f=>f.ctx.env.COVER_R2_BUCKET_NAME='amadolibros-images-preview',
    f=>f.ctx.env.APP_ENV='preview',f=>f.item.status='paused',f=>f.item.available_quantity=0,
    f=>delete f.item.pictures,f=>f.item.id='MLU697305757']) {
    const f=await fixture();change(f);assert.equal(await readyCardVariantSource(f.ctx,f.item),null);assert.equal(f.heads,0);
  }
});

test('drift, incomplete variants and misleading 200/original metadata stay on legacy delivery',async()=>{
  for(const change of [f=>f.item.pictures=['https://http2.mlstatic.com/changed-O.jpg'],
    f=>f.variants.delete(f.variants.keys().next().value),
    f=>f.variants.values().next().value.httpMetadata.contentType='image/jpeg',
    f=>f.variants.values().next().value.customMetadata.recipe='original-fallback']) {
    const f=await fixture();change(f);assert.equal(await readyCardVariantSource(f.ctx,f.item),null);
  }
});

test('legacy index fallback cannot activate permanent cards',async()=>{
  const f=await fixture();f.objects.clear();
  assert.equal(await readyCardVariantSource(f.ctx,f.item),null);
});
