import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {processOne,run,readList} from '../../scripts/vintage-cloud/eliminar.mjs';

function fakeMl(items){
 const puts=[];
 return {puts,get:async p=>{const id=p.match(/MLU\d+/)[0];if(!items[id])throw Object.assign(new Error('x'),{code:'http_404'});return items[id];},put:async(p,body)=>{puts.push([p.match(/MLU\d+/)[0],body]);return {};}};
}
const vintage=(id,extra={})=>({id,seller_id:2341378249,status:'active',title:'Libro Digital X',seller_custom_field:'AMADO-AR-9789502323060',price:1990,available_quantity:1,sale_terms:[{id:'MANUFACTURING_TIME'}],...extra});

test('without --real nothing is written; another seller is never touched',async()=>{
 const ml=fakeMl({MLU1:vintage('MLU1'),MLU2:vintage('MLU2',{seller_id:440298103})});
 const s=await run({ids:['MLU1','MLU2'],ml,real:false,log:()=>{}});
 assert.deepEqual(s.resultados,{se_eliminaria:1,otra_cuenta_no_se_toca:1});assert.equal(ml.puts.length,0);
});

test('with --real each Vintage listing is closed and then deleted, and the ISBN is kept for selling elsewhere',async()=>{
 const ml=fakeMl({MLU1:vintage('MLU1'),MLU3:vintage('MLU3',{status:'closed'}),MLU4:vintage('MLU4',{seller_id:440298103})});
 const lines=[];
 const s=await run({ids:['MLU1','MLU3','MLU4','MLU9'],ml,real:true,log:l=>lines.push(l)});
 const puts=ml.puts.map(([id,b])=>id+':'+JSON.stringify(b)).sort();
 assert.deepEqual(puts,['MLU1:{"deleted":"true"}','MLU1:{"status":"closed"}','MLU3:{"deleted":"true"}']);
 assert.ok(!ml.puts.some(([id])=>id==='MLU4'),'Amado Libros is never touched');
 assert.equal(s.resultados.eliminada,2);assert.equal(s.resultados.otra_cuenta_no_se_toca,1);assert.equal(s.resultados.no_se_pudo_leer,1);
 assert.ok(lines.some(l=>l.includes('9789502323060')));
});

test('the approved list has exactly the 2725 listings and only MLU numbers',async()=>{
 const ids=await readList(new URL('../../scripts/vintage-cloud/eliminar-2026-11-09.txt',import.meta.url));
 assert.equal(ids.length,2725);assert.ok(ids.every(i=>/^MLU\d+$/.test(i)));
});
