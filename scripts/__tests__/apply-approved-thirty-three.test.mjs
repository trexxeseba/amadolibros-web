import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateManifest,createApproved33Engine,HASH} from '../mercadolibre/apply-approved-thirty-three.mjs';
const manifest=JSON.parse(fs.readFileSync(new URL('../mercadolibre/approved-thirty-three-manifest.json',import.meta.url)));
function fixture(id){
 const p=structuredClone(manifest.approved.find(p=>id?p.id===id:p.members.some(m=>m.action==='corregir')));
 const items=p.members.map(m=>({id:m.id,seller_id:440298103,status:'active',category_id:'MLU1196',catalog_listing:m.catalog_listing,user_product_id:p.up,variations:[],title:'Keep title',price:100,shipping:{mode:'me2'},sale_terms:[],attributes:[{id:'GTIN',value_name:p.isbn},{id:'SELLER_PACKAGE_WEIGHT',value_name:'500 g'},...(m.before?[{id:p.attribute,...m.before}]:[])]}));
 const saved=new Map(),puts=[];let extra=false,mutate=false,propagate=false,conflicts409=0,ignorePeer=false;
 const receipts={read:async id=>saved.get(id),claim:async(id,b)=>{if(saved.has(id))return false;saved.set(id,{state:'attempting',before_json:JSON.stringify(b)});return true;},save:async(id,state,result)=>saved.set(id,{...saved.get(id),state,result_json:JSON.stringify(result)})};
 receipts.retry409=async id=>{const r=saved.get(id),b=JSON.parse(r.result_json);if(b.error!=='ml_put_http_409'||b.retry_count)return false;r.state='attempting_after_409_readback';return true;};
 const ml=async(path,method='GET',body)=>{
  if(path.startsWith('/users/')){const status=new URLSearchParams(path.split('?')[1]).get('status');const ids=!status||status==='active'?[...items.map(i=>i.id),...(extra?['MLU999999999']:[])]:[];return {paging:{total:ids.length},results:ids};}
  if(path.includes('/categories/'))return [{id:p.attribute,value_type:p.payload.value_id?'list':'string',values:p.payload.value_id?[{id:p.payload.value_id,name:p.value}]:[]}];
  if(path.endsWith('/description'))return {plain_text:'Keep description'};
  const i=items.find(i=>path.split('?')[0]==='/items/'+i.id);assert.ok(i);
  if(method==='PUT'){
   assert.ok(saved.has('G:'+p.id));assert.ok(saved.has('W:'+i.id));assert.deepEqual(body,{attributes:[p.payload]});puts.push(i.id);if(i.id!==p.id&&conflicts409-->0)throw Error('ml_put_http_409');
   if(ignorePeer&&i.id!==p.id)return {};
   for(const x of propagate?items:[i]){x.attributes=x.attributes.filter(a=>a.id!==p.attribute);x.attributes.push({id:p.attribute,value_name:p.value,...p.payload});}
   if(mutate)items[0].price=101;return {};
  }
  return structuredClone(i);
 };
 return {p,items,saved,puts,engine:createApproved33Engine({ml,receipts,wait:async()=>{}}),set extra(v){extra=v;},set mutate(v){mutate=v;},set propagate(v){propagate=v;},set conflicts409(v){conflicts409=v;},set ignorePeer(v){ignorePeer=v;}};
}
test('cryptographic scope fixes all 33 changes, 3 corrections and excluded fields',()=>{
 assert.equal(validateManifest(manifest).approved.length,28);
 for(const mutation of [m=>m.approved[0].value='Salud',m=>m.approved[0].members[1].action='corregir',m=>m.approved[0].attribute='TITLE']){const bad=structuredClone(manifest);mutation(bad);assert.throws(()=>validateManifest(bad));}
});
test('named correction and target missing value are written once with durable backups',async()=>{
 const f=fixture();const pre=await f.engine.plan(f.p);assert.equal(pre.ready.length,2);
 const result=await f.engine.apply(f.p,pre);assert.equal(result.state,'verified');assert.equal(f.puts.length,2);
 assert.equal(JSON.parse(f.saved.get('G:'+f.p.id).before_json).review_hash,HASH);
 await f.engine.apply(f.p,pre);assert.equal(f.puts.length,2);
});
test('a correction never authorizes a newly changed peer value',async()=>{
 const f=fixture();f.items[1].attributes.find(a=>a.id===f.p.attribute).value_name='Unexpected';f.items[1].attributes.find(a=>a.id===f.p.attribute).values=[];
 await assert.rejects(f.engine.plan(f.p),/authorized_before_value_changed/);assert.equal(f.puts.length,0);
});
test('existing and N/A values cannot be filled as missing',async()=>{
 for(const a of [{value_name:'N/A'},{value_id:'-1',value_name:null},{value_name:'Other'}]){const f=fixture();f.items[0].attributes.push({id:f.p.attribute,...a});await assert.rejects(f.engine.plan(f.p),/authorized_before_value_changed/);assert.equal(f.puts.length,0);}
});
test('an unchanged linked value stays read-only',async()=>{
 const f=fixture('MLU642343669');await f.engine.apply(f.p,await f.engine.plan(f.p));assert.deepEqual(f.puts,[f.p.id]);
});
test('singleton group is revalidated and verified',async()=>{
 const f=fixture('MLU1333190898');const r=await f.engine.apply(f.p,await f.engine.plan(f.p));assert.equal(r.item_ids.length,1);assert.equal(f.puts.length,1);
});
test('automatic propagation avoids a second request but verifies both values',async()=>{
 const f=fixture();f.propagate=true;await f.engine.apply(f.p,await f.engine.plan(f.p));assert.equal(f.puts.length,1);
});
test('extra group member blocks before writing',async()=>{
 const f=fixture();f.extra=true;await assert.rejects(f.engine.plan(f.p),/authorized_group_changed/);assert.equal(f.puts.length,0);
});
test('price change since preflight blocks before writing',async()=>{
 const f=fixture();const pre=await f.engine.plan(f.p);f.items[0].price=101;assert.equal((await f.engine.apply(f.p,pre)).state,'blocked');assert.equal(f.puts.length,0);
});
test('unexpected protected change after PUT stops all further writes',async()=>{
 const f=fixture();f.mutate=true;await assert.rejects(f.engine.apply(f.p,await f.engine.plan(f.p)),/protected_or_other_attributes_changed/);assert.equal(f.puts.length,1);assert.equal(f.saved.get('G:'+f.p.id).state,'uncertain_no_retry');
});
test('only a single 409 retry occurs after complete fresh revalidation',async()=>{
 const f=fixture();f.conflicts409=1;await f.engine.apply(f.p,await f.engine.plan(f.p));assert.equal(f.puts.length,3);
 const g=fixture();g.conflicts409=5;await assert.rejects(g.engine.apply(g.p,await g.engine.plan(g.p)),/ml_put_http_409/);assert.equal(g.puts.length,3);
});
test('accepted but ignored peer correction is recorded and never reissued',async()=>{
 const f=fixture();f.ignorePeer=true;
 await assert.rejects(f.engine.apply(f.p,await f.engine.plan(f.p)),/written_value_not_persisted/);
 assert.equal(f.puts.length,2);assert.equal(f.saved.get('G:'+f.p.id).state,'uncertain_no_retry');
 const r=await f.engine.apply(f.p,await f.engine.plan(f.p));assert.equal(r.state,'prior_unresolved_no_retry');assert.equal(f.puts.length,2);
});
