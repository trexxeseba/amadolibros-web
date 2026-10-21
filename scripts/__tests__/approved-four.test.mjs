import test from 'node:test';
import assert from 'node:assert/strict';
import {APPROVED,createFourPilot} from '../mercadolibre/approved-four-worker.mjs';
function fixture({p=APPROVED[0],edit=()=>{},peer=false,incomplete=false,putError=false,sideEffect=false}={}){
  const item={id:p.id,seller_id:440298103,status:'active',category_id:'MLU1196',catalog_listing:false,user_product_id:p.up,variations:[],title:'Título exacto',price:1450,sale_terms:[{id:'MANUFACTURING_TIME',value_name:'1 día'}],attributes:[{id:'GTIN',value_name:p.isbn},{id:'AUTHOR',value_name:'Autor'}]};
  edit(item);
  let receipt=null;const writes=[];
  const receipts={ensure:async()=>{},read:async()=>receipt,claim:async(id,before)=>{if(receipt)return false;receipt={item_id:id,before_json:JSON.stringify(before)};return true;},save:async(_id,state,result)=>Object.assign(receipt,{state,result})};
  const engine=createFourPilot({receipts,tokenProvider:async()=>'private-test-token',wait:async()=>{},fetcher:async(url,init)=>{
    const u=new URL(url);
    if(init.method==='PUT'){
      writes.push({path:u.pathname,body:JSON.parse(init.body)});
      if(putError)throw Error('network_uncertain');
      const a=writes[0].body.attributes[0];
      item.attributes.push({...a,value_name:a.value_name||'Español'});
      if(sideEffect)item.price++;
      return Response.json(item);
    }
    if(u.pathname==='/categories/MLU1196/attributes')return Response.json([{id:'PUBLICATION_YEAR',value_type:'number',tags:{}},{id:'LANGUAGE',values:[{id:'313886',name:'Español'}],tags:{}}]);
    if(u.pathname.endsWith('/items/search')){
      const active=!u.searchParams.get('status')||u.searchParams.get('status')==='active';
      const results=active?[p.id,...(peer?['MLU999999']:[])]:[];
      return Response.json({seller_id:'440298103',paging:{total:results.length+(incomplete?1:0)},results});
    }
    if(u.pathname.endsWith('/description'))return Response.json({plain_text:'Descripción exacta.'});
    if(u.pathname===`/items/${p.id}`)return Response.json(structuredClone(item));
    throw Error('unexpected_route');
  }});
  return {engine,writes,item,get receipt(){return receipt;}};
}
test('aplica los cuatro valores autorizados y únicamente ese atributo; conserva título, precio, descripción y plazo',async()=>{
  for(const p of APPROVED){
    const f=fixture({p});
    const result=await f.engine.apply(p.id);
    assert.equal(result.state,'verified');
    assert.equal(result.protected_fields_unchanged,true);
    assert.deepEqual(f.writes,[{path:`/items/${p.id}`,body:{attributes:[p.attribute==='LANGUAGE'?{id:'LANGUAGE',value_id:'313886'}:{id:'PUBLICATION_YEAR',value_name:p.value}]}}]);
    await f.engine.apply(p.id);
    assert.equal(f.writes.length,1,'no repite una operación con recibo');
  }
});
for(const [name,opts,error] of [
  ['un aviso de Catálogo',{edit:i=>i.catalog_listing=true},'not_active_own_book'],
  ['otro vendedor',{edit:i=>i.seller_id=2341378249},'wrong_seller_or_item'],
  ['ISBN distinto',{edit:i=>i.attributes[0].value_name='9788408167761'},'isbn_changed_or_ambiguous'],
  ['N/A',{edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',value_id:'-1'})},'attribute_not_applicable'],
  ['otro año informado',{edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',value_name:'2000'})},'attribute_present'],
  ['otro aviso del mismo UP',{peer:true},'other_items_share_up'],
  ['búsqueda incompleta',{incomplete:true},'incomplete_up_search'],
])test('bloquea '+name+' antes de escribir',async()=>{const f=fixture(opts);await assert.rejects(f.engine.apply(APPROVED[0].id),new RegExp(error));assert.equal(f.writes.length,0);});
test('rechaza IDs de los otros 16 o cualquier publicación no autorizada',async()=>{const f=fixture();await assert.rejects(f.engine.apply('MLU644094660'),/item_not_approved/);assert.equal(f.writes.length,0);});
test('si el dato ya coincide, no envía PUT',async()=>{const f=fixture({edit:i=>i.attributes.push({id:'PUBLICATION_YEAR',value_name:'1990'})});assert.equal((await f.engine.apply(APPROVED[0].id)).state,'already_matches');assert.equal(f.writes.length,0);});
test('una respuesta incierta de escritura nunca se reintenta automáticamente',async()=>{const f=fixture({putError:true});await assert.rejects(f.engine.apply(APPROVED[0].id),/network_uncertain/);assert.equal(f.receipt.state,'uncertain_no_retry');await f.engine.apply(APPROVED[0].id);assert.equal(f.writes.length,1);});
test('detecta cambios en precio u otros campos protegidos después del PUT y detiene el piloto',async()=>{const f=fixture({sideEffect:true});await assert.rejects(f.engine.apply(APPROVED[0].id),/protected_fields_or_other_attributes_changed/);assert.equal(f.receipt.state,'uncertain_no_retry');});
test('el reporte no escribe en MLU ni crea recibos',async()=>{const f=fixture();assert.equal((await f.engine.report(APPROVED[0].id)).state,'eligible');assert.equal(f.writes.length,0);assert.equal(f.receipt,null);});
