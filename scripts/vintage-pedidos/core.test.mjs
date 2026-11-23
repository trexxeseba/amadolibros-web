import test from 'node:test';
import assert from 'node:assert/strict';
import {F,SELLER,buildSummary,selectNote,syncSales,noteTarget,unpackNotes,validateOrder} from './core.mjs';
const oid='2000000000000001';
const order=()=>({id:oid,seller:{id:SELLER},currency_id:'UYU',status:'paid',date_created:'2026-11-22T16:00:00Z',total_amount:2400,buyer:{first_name:'Test'},order_items:[{item:{id:'MLU0000001',title:'Libro de prueba'},quantity:2,unit_price:1200}],shipping:{id:'1234'},pack_id:'9876'});
function fixture({rows=[],orders=[order()],searchIds=orders.map(o=>o.id),notes=[],postTimeout=false}={}){
 const records=structuredClone(rows),listNotes=structuredClone(notes),writes=[];
 const at={
  list:async()=>structuredClone(records),get:async rid=>structuredClone(records.find(r=>r.id===rid)),
  patch:async(rid,fields)=>{writes.push(['at',fields]);const r=records.find(r=>r.id===rid);Object.assign(r.fields,fields);return structuredClone(r);},
  upsert:async fields=>{let r=records.find(r=>r.fields[F.id]===fields[F.id]);if(!r){r={id:'recTest',fields:{...fields}};records.push(r);}writes.push(['create']);return structuredClone(r);}
 };
 const ml={
  search:async()=>searchIds,
  get:async path=>{
   if(path==='/users/me')return {id:SELLER,site_id:'MLU'};
   if(path.endsWith('/notes'))return [{results:structuredClone(listNotes)}];
   if(path.startsWith('/shipments/'))return {status:'ready_to_ship',substatus:'printed'};
   const o=orders.find(x=>'/orders/'+x.id===path);if(!o)throw Object.assign(new Error(),{code:'ml_http_404'});return structuredClone(o);
  },
  write:async(method,path,b)=>{
   writes.push([method,path,b]);
   if(method==='POST'){listNotes.push({id:'noteOwned',note:b.note});if(postTimeout)throw Object.assign(new Error(),{code:'ml_transporte'});}
   else listNotes.find(n=>path.endsWith('/'+n.id)).note=b.note;
  }
 };
 return {ml,at,records,listNotes,writes};
}
test('paid sale imports once; rerun does not duplicate notes or records',async()=>{
 const t=fixture();const a=await syncSales({...t,real:true});assert.equal(a.created,1);assert.equal(a.notesWritten,1);
 const b=await syncSales({...t,real:true});assert.equal(b.created,0);assert.equal(b.notesWritten,0);
 assert.equal(t.records.length,1);assert.equal(t.listNotes.length,1);
 assert.equal(t.records[0].fields[F.price],2400);
 assert.equal(t.records[0].fields[F.state],'pago_total');
 assert.match(t.records[0].fields[F.title],/× 2/);
});
test('dry run never mutates either service',async()=>{
 const t=fixture();await syncSales(t);assert.equal(t.writes.length,0);assert.equal(t.records.length,0);
});
test('wrong seller blocks writes',async()=>{
 const o=order();o.seller.id='440298103';const t=fixture({orders:[o]});
 const s=await syncSales({...t,real:true});assert.equal(s.errors,1);assert.equal(t.writes.length,0);
});
test('foreign token stops before Airtable',async()=>{
 const t=fixture();t.ml.get=async()=>({id:'440298103',site_id:'MLU'});
 await assert.rejects(syncSales({...t,real:true}),/token_no_es_vintage/);assert.equal(t.writes.length,0);
});
test('cancelled new order is not a paid new order',async()=>{
 const o=order();o.status='cancelled';const t=fixture({orders:[o]});
 await syncSales({...t,real:true});assert.equal(t.records.length,0);
});
test('operator progress and notes survive cancellation update',async()=>{
 const o=order();o.status='cancelled';
 const t=fixture({orders:[o],rows:[{id:'recTest',fields:{[F.id]:oid,[F.state]:'comprado',[F.notes]:'Nota privada',[F.follow]:'Revisar devolución',[F.responsible]:'Gaby'}}]});
 await syncSales({...t,real:true});
 assert.equal(t.records[0].fields[F.state],'comprado');assert.equal(t.records[0].fields[F.notes],'Nota privada');
 assert.equal(t.records[0].fields[F.sale],'cancelled');assert.match(t.listNotes[0].note,/cancelled/);
 assert.doesNotMatch(t.listNotes[0].note,/Nota privada/);
});
test('manual notes are preserved while owned note is added',async()=>{
 const t=fixture({notes:[{id:'manual',note:'Llamar al cliente'}]});
 await syncSales({...t,real:true});assert.equal(t.listNotes[0].note,'Llamar al cliente');assert.equal(t.listNotes.length,2);
});
test('manual edits of owned note are detected, never overwritten',async()=>{
 const t=fixture();await syncSales({...t,real:true});t.listNotes[0].note+=' humano';
 const before=t.writes.length;const s=await syncSales({...t,real:true});assert.equal(s.errors,1);
 assert.equal(t.writes.slice(before).filter(w=>w[0]==='PUT').length,0);
 assert.match(t.records[0].fields[F.sync],/nota_editada_manualmente/);
});
test('POST accepted but timed out is recovered without a duplicate',async()=>{
 const t=fixture({postTimeout:true});const a=await syncSales({...t,real:true});assert.equal(a.errors,1);
 const b=await syncSales({...t,real:true});assert.equal(b.errors,0);assert.equal(t.listNotes.length,1);
});
test('operator change updates the same owned note',async()=>{
 const t=fixture();await syncSales({...t,real:true});t.records[0].fields[F.follow]='Recibido, preparar paquete';
 await syncSales({...t,real:true});assert.equal(t.listNotes.length,1);assert.match(t.listNotes[0].note,/preparar paquete/);
});
test('duplicate Airtable IDs fail before writes',async()=>{
 const t=fixture({rows:[{id:'a',fields:{[F.id]:oid}},{id:'b',fields:{[F.id]:oid}}]});
 await assert.rejects(syncSales({...t,real:true}),/airtable_venta_duplicada/);assert.equal(t.writes.length,0);
});
test('300-character limit, stable summary, and no private internal notes',()=>{
 const f={[F.state]:'comprado',[F.follow]:'á😀'.repeat(500),[F.notes]:'PRIVATE'};
 const s=buildSummary(f,oid);assert.ok([...s].length<=300);assert.equal(s,buildSummary(f,oid));assert.ok(!s.includes('PRIVATE'));
});
test('unrecognized note response fails closed',()=>{
 assert.throws(()=>unpackNotes({unexpected:[]}),/notas_respuesta_invalida/);
 assert.throws(()=>selectNote([{id:'x',note:'[AMADO '+oid+'] manual'}],{},oid),/nota_sin_recibo/);
});
test('pack target is used when present; legacy order otherwise',()=>{
 assert.equal(noteTarget(order()),'/packs/9876/notes');const o=order();delete o.pack_id;assert.equal(noteTarget(o),'/orders/'+oid+'/notes');
});
test('orders still tracked after leaving discovery are refreshed',async()=>{
 const t=fixture({searchIds:[],rows:[{id:'recTest',fields:{[F.id]:oid,[F.state]:'comprado'}}]});
 const s=await syncSales({...t,real:true});assert.equal(s.read,1);assert.equal(s.errors,0);
});
test('unsafe numerical order IDs are rejected',()=>{
 const o=order();o.id=10000000000000000;assert.throws(()=>validateOrder(o,o.id),/id_inseguro/);
});
