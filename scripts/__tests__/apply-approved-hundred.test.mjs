import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateManifest,state,payloadFor,createEngine,snapshotKey} from '../mercadolibre/apply-approved-hundred.mjs';
const m=JSON.parse(fs.readFileSync(new URL('../mercadolibre/approved-hundred-manifest.json',import.meta.url)));
function fixture(){
 const p=m.approved[0],items=[{id:p.id,catalog_listing:false},{id:p.peers[0].id,catalog_listing:true}].map(i=>({...i,seller_id:440298103,status:'active',category_id:'MLU1196',user_product_id:p.up,variations:[],title:i.id,price:100,sale_terms:[],shipping:{mode:'me2'},attributes:[{id:'GTIN',value_name:p.isbn},{id:'AUTHOR',value_name:'Keep author'}]}));
 const schema=p.changes.map(c=>({id:c.attribute,value_type:c.payload.value_id?'list':'string',...(c.payload.value_id?{values:[{id:c.payload.value_id,name:c.value}]}:{})}));
 const saved=new Map();let puts=0,extra=false,mutate=false,propagate=true,peer409=0;
 const receipts={read:async id=>saved.get(id),claim:async(id,b)=>{if(saved.has(id))return false;saved.set(id,{state:'attempting',before_json:JSON.stringify(b)});return true;},save:async(id,state,v)=>saved.set(id,{...saved.get(id),state,result_json:JSON.stringify(v)})};
 receipts.retry409=async(id,body)=>{const r=saved.get(id),info=JSON.parse(r.result_json??'{}');if(info.error!=='ml_put_http_409'||info.retry_count)return false;r.state='attempting_after_409_readback';r.result_json=JSON.stringify({retry_count:1});return true;};
 const ml=async(path,method='GET',body)=>{
  if(path.startsWith('/users/')){const status=new URLSearchParams(path.split('?')[1]).get('status');const ids=!status||status==='active'?[...items.map(i=>i.id),...(extra?['MLU999999999']:[])]:[];return {paging:{total:ids.length},results:ids};}
  if(path.includes('/categories/'))return structuredClone(schema);
  if(path.endsWith('/description'))return {plain_text:'Keep description'};
  const i=items.find(i=>path.split('?')[0]==='/items/'+i.id);assert.ok(i);
  if(method==='PUT'){puts++;if(i.id!==p.id&&peer409-->0)throw Error('ml_put_http_409');assert.ok(saved.has(i.id),'durable backup before PUT');assert.deepEqual(Object.keys(body),['attributes']);for(const a of body.attributes){const c=p.changes.find(c=>c.attribute===a.id);for(const j of (propagate?items:[i]))j.attributes.push({...a,value_name:c.value});}if(mutate)items[1].title='Unexpected change';return {};}
  return structuredClone(i);
 };
 return {p,items,schema,saved,receipts,engine:createEngine({ml,receipts,wait:async()=>{}}),get puts(){return puts;},set extra(v){extra=v;},set mutate(v){mutate=v;},set propagate(v){propagate=v;},set peer409(v){peer409=v;}};
}
test('frozen scope: 100 targets, 100 named peers, 280 allowed attributes, original 16 excluded',()=>{validateManifest(m);const copy=structuredClone(m);copy.approved[0].changes[0].attribute='TITLE';assert.throws(()=>validateManifest(copy));});
test('N/A, present empty and mismatches never count as missing',()=>{const c=m.approved[0].changes[0];for(const a of [{id:c.attribute,value_id:'-1'},{id:c.attribute},{id:c.attribute,value_name:'different'}])assert.notEqual(state({attributes:[a]},c),'missing');});
test('peer conflict excludes only that field from payload',()=>{const f=fixture(),c=f.p.changes[0];f.items[1].attributes.push({id:c.attribute,value_name:'different'});const r=payloadFor(f.p,f.items,f.schema);assert.ok(!r.ready.some(x=>x.attribute===c.attribute));assert.equal(r.skipped[0].reason,'existing_or_na_value');});
test('changed or extra group member blocks before writing',async()=>{const f=fixture();f.extra=true;await assert.rejects(f.engine.plan(f.p),/authorized_group_changed/);assert.equal(f.puts,0);});
test('writes once after persistent backup, verifies target and peer and prevents retries',async()=>{const f=fixture(),pre=await f.engine.plan(f.p);const r=await f.engine.apply(f.p,pre);assert.equal(r.state,'verified');assert.equal(r.items.length,2);assert.equal(f.puts,1);assert.equal((await f.engine.apply(f.p,pre)).state,'prior_verified_no_retry');assert.equal(f.puts,1);});
test('change in protected peer data stops verification and preserves uncertain receipt',async()=>{const f=fixture(),pre=await f.engine.plan(f.p);f.mutate=true;await assert.rejects(f.engine.apply(f.p,pre),/protected_or_other_attributes_changed/);assert.equal(f.saved.get(f.p.id).state,'uncertain_no_retry');assert.equal(f.puts,1);});
test('change since preflight prevents PUT',async()=>{const f=fixture(),pre=await f.engine.plan(f.p);f.items[0].price=101;assert.equal((await f.engine.apply(f.p,pre)).state,'blocked');assert.equal(f.puts,0);});

test('explicitly authorized peer receives only missing fields when propagation does not occur',async()=>{const f=fixture();f.propagate=false;const pre=await f.engine.plan(f.p);const r=await f.engine.apply(f.p,pre);assert.equal(r.state,'verified');assert.equal(f.puts,2);assert.equal(f.saved.get(f.p.peers[0].id).state,'verified');});

test('ML ordinal normalization is accepted only for the same complete edition number',()=>{const c={attribute:'BOOK_EDITION',value:'1ª'};assert.equal(state({attributes:[{id:'BOOK_EDITION',value_name:'1',value_id:'1852472'}]},c),'matches');for(const v of ['2','2014','1ª revisada','1ª 2024'])assert.equal(state({attributes:[{id:'BOOK_EDITION',value_name:v}]},c),'conflict');});

test('sale terms compare content independently of API order, while preserving values',()=>{const a=[{id:'x',protected:{sale_terms:[{id:'WARRANTY_TYPE',value_name:'factory'},{id:'WARRANTY_TIME',value_name:'1 months'}]}}];const b=structuredClone(a);b[0].protected.sale_terms.reverse();assert.equal(snapshotKey(a),snapshotKey(b));b[0].protected.sale_terms[0].value_name='2 months';assert.notEqual(snapshotKey(a),snapshotKey(b));});

test('author initials punctuation may normalize but different authors still fail',()=>{const a=[{id:'x',protected:{},other_attributes:[{id:'AUTHOR',value_id:'old',value_name:'Mark Z Danielewski',values:[{id:'old',name:'Mark Z Danielewski',struct:null}]}]}];const b=structuredClone(a);b[0].other_attributes[0]={id:'AUTHOR',value_id:'new',value_name:'Mark Z. Danielewski',values:[{id:'new',name:'Mark Z. Danielewski',struct:null}]};assert.equal(snapshotKey(a),snapshotKey(b));b[0].other_attributes[0].value_name='Other Author';assert.notEqual(snapshotKey(a),snapshotKey(b));});

test('ISBN value is preserved when ML removes only its internal enum ID',()=>{const a=[{id:'x',protected:{},other_attributes:[{id:'GTIN',value_id:'69170066',value_name:'9780194527675',values:[{id:'69170066',name:'9780194527675',struct:null}]}]}];const b=structuredClone(a);b[0].other_attributes[0].value_id=null;b[0].other_attributes[0].values[0].id=null;assert.equal(snapshotKey(a),snapshotKey(b));b[0].other_attributes[0].value_name='9780194527682';assert.notEqual(snapshotKey(a),snapshotKey(b));});

test('a single 409 retry requires fresh empty-field readback and a persistent retry claim',async()=>{const f=fixture();f.propagate=false;f.peer409=1;const r=await f.engine.apply(f.p,await f.engine.plan(f.p));assert.equal(r.state,'verified');assert.equal(f.puts,3);assert.equal(JSON.parse(f.saved.get(f.p.peers[0].id).result_json).retry_count,1);});
test('repeated 409 stops after one retry without unbounded writes',async()=>{const f=fixture();f.propagate=false;f.peer409=5;await assert.rejects(f.engine.apply(f.p,await f.engine.plan(f.p)),/ml_put_http_409/);assert.equal(f.puts,3);});
