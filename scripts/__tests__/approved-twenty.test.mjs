import test from 'node:test';
import assert from 'node:assert/strict';
import worker,{APPROVED,createTwentyPilot} from '../mercadolibre/approved-twenty-worker.mjs';
function fixture({p=APPROVED[0],edit=()=>{},peer=false,peerState='closed',empty=false,incomplete=false,putError=false,sideEffect=false,schemaEdit=()=>{},race=false}={}){
 const item={id:p.id,seller_id:440298103,status:'active',category_id:'MLU1196',catalog_listing:false,catalog_product_id:null,user_product_id:p.up,variations:[],title:'Título exacto',price:1450,available_quantity:2,sale_terms:[{id:'MANUFACTURING_TIME',value_name:'18 días'}],attributes:[{id:'GTIN',value_name:p.isbn},{id:'AUTHOR',value_name:'Autor'}]};edit(item);
 const fields=[{id:'PUBLICATION_YEAR',value_type:'number',tags:{}},{id:'PAGES_NUMBER',value_type:'number',tags:{}},{id:'BOOK_COVER',value_type:'list',values:[{id:'cover-soft',name:'Blanda'}],tags:{}},{id:'BOOK_EDITION',value_type:'string',tags:{}},{id:'LANGUAGE',value_type:'list',values:[{id:'313886',name:'Español'}],tags:{}}];schemaEdit(fields);
 let receipt=null,reads=0;const writes=[];
 const receipts={ensure:async()=>{},read:async()=>receipt,claim:async(id,before)=>{if(receipt)return false;receipt={item_id:id,before_json:JSON.stringify(before)};return true;},save:async(_id,state,result)=>Object.assign(receipt,{state,result})};
 const engine=createTwentyPilot({receipts,tokenProvider:async()=>'private-test-token',wait:async()=>{},fetcher:async(url,init)=>{
  const u=new URL(url);
  if(init.method==='PUT'){
   writes.push({path:u.pathname,body:JSON.parse(init.body)});if(putError)throw Error('network_uncertain');
   for(const a of writes.at(-1).body.attributes){const f=fields.find(f=>f.id===a.id),value_name=a.value_name||f.values.find(v=>v.id===a.value_id).name;item.attributes.push({...a,value_name});}
   if(sideEffect)item.price++;return Response.json(item);
  }
  if(u.pathname==='/categories/MLU1196/attributes')return Response.json(fields);
  if(u.pathname.endsWith('/items/search')){
   const status=u.searchParams.get('status'),results=empty?[]:(!status||status==='active'?[p.id]:[]);
   if(peer&&status===peerState)results.push('MLU999999');
   return Response.json({seller_id:'440298103',paging:{total:results.length+(incomplete?1:0)},results});
  }
  if(u.pathname.endsWith('/description'))return Response.json({plain_text:'Descripción exacta.'});
  if(u.pathname===`/items/${p.id}`){reads++;if(race&&reads===2)item.attributes.push({id:p.changes[0].attribute,value_name:'Otro valor'});return Response.json(structuredClone(item));}
  throw Error('unexpected_route');
 }});
 return {engine,writes,item,get receipt(){return receipt;}};
}
test('lista fija de exactamente 20 ítems y 25 atributos autorizados; excluye los cuatro previos',()=>{
 assert.equal(APPROVED.length,20);assert.equal(new Set(APPROVED.map(p=>p.id)).size,20);assert.equal(APPROVED.reduce((n,p)=>n+p.changes.length,0),25);
 for(const id of ['MLU683126476','MLU925948404','MLU1317435246','MLU1488351638'])assert.ok(!APPROVED.some(p=>p.id===id));
 for(const p of APPROVED)for(const c of p.changes)assert.ok(['PUBLICATION_YEAR','PAGES_NUMBER','BOOK_COVER','BOOK_EDITION','LANGUAGE'].includes(c.attribute));
});
test('aplica únicamente valores autorizados, con respaldo recuperable y una escritura por ítem',async()=>{
 for(const p of APPROVED){const f=fixture({p});assert.equal((await f.engine.apply(p.id)).state,'verified');assert.equal(f.writes.length,1);assert.equal(f.writes[0].path,`/items/${p.id}`);assert.deepEqual(Object.keys(f.writes[0].body),['attributes']);assert.deepEqual(f.writes[0].body.attributes.map(a=>a.id),p.changes.map(c=>c.attribute));
  const r=await f.engine.receipt(p.id);assert.equal(r.receipt.state,'verified');const backup=JSON.parse(r.receipt.before_json);assert.equal(backup.item.price,1450);assert.equal(backup.item.sale_terms[0].value_name,'18 días');assert.equal(backup.description,'Descripción exacta.');
  await f.engine.apply(p.id);assert.equal(f.writes.length,1);
 }
});
for(const[name,opts,error]of[
 ['Catálogo',{edit:i=>i.catalog_listing=true},'not_active_own_book'],['otro vendedor',{edit:i=>i.seller_id=2341378249},'wrong_seller_or_item'],
 ['pausada',{edit:i=>i.status='paused'},'not_active_own_book'],['otra categoría',{edit:i=>i.category_id='MLU1'},'not_active_own_book'],
 ['ISBN distinto',{edit:i=>i.attributes[0].value_name='9788408167761'},'isbn_changed_or_ambiguous'],
 ['N/A',{edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',value_id:'-1'})},'attribute_not_applicable'],
 ['N/A dentro de values',{edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',values:[{id:'-1'}]})},'attribute_not_applicable'],
 ['valor existente distinto',{edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',value_name:'2000'})},'attribute_present'],
 ['atributo presente vacío',{edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',value_name:null})},'attribute_present'],
 ['otro aviso cerrado oculto en búsqueda por defecto',{peer:true},'other_items_share_up'],
 ['búsqueda vacía',{empty:true},'own_item_missing_from_up_search'],['búsqueda incompleta',{incomplete:true},'incomplete_up_search'],
 ['UP distinto',{edit:i=>i.user_product_id='MLUU999'},'changed_user_product_or_variations'],
 ['variaciones',{edit:i=>i.variations=[{id:1}]},'changed_user_product_or_variations'],
 ['tipo numérico con unidad',{schemaEdit:f=>f[0].value_type='number_unit'},'numeric_unit_requires_review'],
 ['valor de lista desconocido',{schemaEdit:f=>f[2].values=[]},'value_not_in_category'],
 ['campo de solo lectura',{schemaEdit:f=>f[0].tags.read_only=true},'attribute_not_writable'],
 ['cambio entre preflight y aplicación',{race:true},'attribute_present'],
])test('bloquea '+name+' antes de escribir',async()=>{const f=fixture(opts);await assert.rejects(f.engine.apply(APPROVED[0].id),new RegExp(error));assert.equal(f.writes.length,0);assert.equal(f.receipt,null);});
test('el reporte no escribe ni crea recibos; rechaza IDs ajenos a esta autorización',async()=>{const f=fixture();assert.equal((await f.engine.report(APPROVED[0].id)).state,'eligible');assert.equal(f.writes.length,0);assert.equal(f.receipt,null);await assert.rejects(f.engine.apply('MLU644094660'),/item_not_approved/);});
test('si una parte ya coincide, escribe los otros faltantes sin reenviar ese campo',async()=>{const p=APPROVED[0],f=fixture({edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',value_name:'2018'})});assert.equal((await f.engine.apply(p.id)).state,'verified');assert.ok(!f.writes[0].body.attributes.some(a=>a.id==='PUBLICATION_YEAR'));});
test('si todos coinciden no envía PUT',async()=>{const p=APPROVED[0],f=fixture({edit:i=>i.attributes.push(...p.changes.map(c=>({id:c.attribute,value_name:c.value})))});assert.equal((await f.engine.apply(p.id)).state,'already_matches');assert.equal(f.writes.length,0);});
test('fallo incierto no se reintenta automáticamente y queda registrado',async()=>{const f=fixture({putError:true});await assert.rejects(f.engine.apply(APPROVED[0].id),/network_uncertain/);assert.equal(f.receipt.state,'uncertain_no_retry');await f.engine.apply(APPROVED[0].id);assert.equal(f.writes.length,1);});
test('cambio de campo protegido detiene la verificación y conserva recibo',async()=>{const f=fixture({sideEffect:true});await assert.rejects(f.engine.apply(APPROVED[0].id),/protected_fields_or_other_attributes_changed/);assert.equal(f.receipt.state,'uncertain_no_retry');});
test('requiere clave, vigencia y modo aplicar explícito',async()=>{const request=()=>new Request('https://example.invalid/apply',{method:'POST',headers:{authorization:'Bearer test','Content-Type':'application/json'},body:JSON.stringify({id:APPROVED[0].id})});assert.equal((await worker.fetch(request(),{})).status,401);assert.equal((await worker.fetch(request(),{PILOT_SECRET:'test',PILOT_EXPIRES_AT:'1'})).status,410);assert.equal((await(await worker.fetch(request(),{PILOT_SECRET:'test',PILOT_EXPIRES_AT:String(Date.now()+60000)})).json()).error,'apply_not_enabled');});
