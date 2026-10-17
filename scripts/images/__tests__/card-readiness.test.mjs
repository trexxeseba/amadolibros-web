import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareCardReadiness } from '../prepare-card-readiness.mjs';
const recipes=['v1-240-q85','v1-360-q85','v1-480-q85'];
function fixture(){
  const masters=Array.from({length:2788},(_,i)=>({file:i.toString(16).padStart(64,'0')+'.jpg',size:100}));
  const plan={schema:'active-card-variants-v1',bucket:'amadolibros-images-production',baseline:'29c5dce82ce807fdcd58d3c49c21fc64dc2b5cea',recipes,masters,
    masters_sha256:createHash('sha256').update(JSON.stringify(masters)).digest('hex'),manifest_updated_at:'frozen-m',catalog_updated_at:'frozen-c'};
  const manifest={updated_at:'frozen-m',entries:{}}, catalog={updated_at:'frozen-c',items:[]},verified={};
  for(let i=0;i<2790;i++){
    const hash=masters[i%2788].file.slice(0,64),id='MLU'+(i+1),source='https://http2.mlstatic.com/D_'+i+'-O.jpg';
    catalog.items.push({id,status:'active',available_quantity:1,pictures:[source]});
    manifest.entries[id+':0']={current:{object_key:`covers/v1/objects/${hash}.jpg`,sha256:hash,source_url:source}};
    for(const r of recipes)verified[hash+'/'+r]={bytes:100,sha256:'a'.repeat(64)};
  }
  return {manifest,catalog,plan,verified};
}
test('readiness artifact covers exact scope and is immutable by digest, without network/writes',()=>{
  const f=fixture(), result=prepareCardReadiness(f);
  assert.equal(Object.keys(JSON.parse(result.text).cards).length,2790);
  assert.equal(createHash('sha256').update(result.text).digest('hex'),result.digest);
  assert.equal(result.key,`covers/card-readiness/v1/${result.digest}.json`);
});
test('aggregate counts cannot replace object evidence; missing/malformed evidence and drift rejected',()=>{
  for(const mutate of [f=>delete f.verified[Object.keys(f.verified)[0]],
    f=>f.verified[Object.keys(f.verified)[0]].sha256='bad',
    f=>f.catalog.items[0].pictures=['https://http2.mlstatic.com/changed-O.jpg'],
    f=>f.manifest.updated_at='different',f=>f.catalog.items[0].status='paused']){
    const f=fixture();mutate(f);assert.throws(()=>prepareCardReadiness(f));
  }
});
