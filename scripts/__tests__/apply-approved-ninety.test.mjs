import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {validateManifest,createEngine,state,payloadFor,snapshot} from '../mercadolibre/apply-approved-ninety.mjs';
const m=JSON.parse(fs.readFileSync(new URL('../mercadolibre/approved-ninety-manifest.json',import.meta.url)));
test('ninety authorized fields partition into 64 schema-supported and 26 excluded fields',()=>{
 validateManifest(m);assert.equal(m.approved.reduce((n,p)=>n+p.changes.length,0)+m.schema_blocked.length,90);
 assert.equal(m.excluded_conditional_fields.length,2);
 for(const p of m.approved){assert.ok(!m.excluded_ids.includes(p.id));for(const c of p.changes)assert.ok(!m.excluded_conditional_fields.some(x=>x.id===p.id&&x.attribute===c.attribute));}
 const bad=structuredClone(m);bad.approved[0].changes[0].attribute='TITLE';assert.throws(()=>validateManifest(bad));
});
test('unlisted genre cannot silently become a broad genre',()=>{
 const p={changes:[{attribute:'BOOK_GENRE',value:'Tarot',payload:{id:'BOOK_GENRE',value_name:'Tarot'}}]};
 assert.throws(()=>payloadFor(p,[{attributes:[]}],[{id:'BOOK_GENRE',value_type:'list',values:[{id:'1',name:'Esoterismo'}]}]),/value_not_in_schema/);
});
test('textual N/A and empty existing values are preserved',()=>{
 for(const a of [{id:'BOOK_GENRE',value_name:'N/A'},{id:'BOOK_GENRE',value_id:'-1'},{id:'BOOK_GENRE'}])assert.notEqual(state({attributes:[a]},{attribute:'BOOK_GENRE',value:'Religión'}),'missing');
});
test('new receipt contains the current authorization and protected package weight',async()=>{
 const p=m.approved[0],saved=new Map();let puts=0;
 const items=[{id:p.id,catalog_listing:false},...p.peers].map(i=>({...i,seller_id:440298103,status:'active',category_id:'MLU1196',user_product_id:p.up,variations:[],title:'Keep title',price:100,sale_terms:[],attributes:[{id:'GTIN',value_name:p.isbn},{id:'SELLER_PACKAGE_WEIGHT',value_name:'900 g'}]}));
 const schema=p.changes.map(c=>({id:c.attribute,value_type:c.payload.value_id?'list':'string',values:c.payload.value_id?[{id:c.payload.value_id,name:c.value}]:[]}));
 const receipts={read:async id=>saved.get(id),claim:async(id,b)=>{assert.ok(!saved.has(id));saved.set(id,{state:'attempting',before_json:JSON.stringify(b)});return true;},save:async(id,state,result)=>{saved.set(id,{...saved.get(id),state,result_json:JSON.stringify(result)});}};
 const ml=async(path,method='GET',body)=>{
  if(path.startsWith('/users/')){const s=new URLSearchParams(path.split('?')[1]).get('status');const ids=!s||s==='active'?items.map(i=>i.id):[];return {paging:{total:ids.length},results:ids};}
  if(path.includes('/categories/'))return schema;
  if(path.endsWith('/description'))return {plain_text:'Keep description'};
  const i=items.find(i=>path.split('?')[0]==='/items/'+i.id);assert.ok(i);
  if(method==='PUT'){puts++;assert.ok(saved.has(i.id));assert.deepEqual(Object.keys(body),['attributes']);for(const a of body.attributes)for(const j of items)j.attributes.push({...a,value_name:p.changes.find(c=>c.attribute===a.id).value});return {};}
  return structuredClone(i);
 };
 const engine=createEngine({ml,receipts,reviewHash:m.review_hash});const pre=await engine.plan(p);await engine.apply(p,pre);
 assert.equal(JSON.parse(saved.get(p.id).before_json).review_hash,m.review_hash);assert.equal(puts,1);
 assert.ok(snapshot(items,items.map(()=>''),p.changes)[0].other_attributes.some(a=>a.id==='SELLER_PACKAGE_WEIGHT'));
 await engine.apply(p,pre);assert.equal(puts,1);
});
