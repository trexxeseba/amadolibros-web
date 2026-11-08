import test from 'node:test';
import assert from 'node:assert/strict';
import {processOne,run,readList} from '../../scripts/vintage-cloud/pausar.mjs';

function fakeMl(items,{stubborn=[]}={}){
 const puts=[];
 return {puts,get:async p=>{const id=p.match(/MLU\d+/)[0];if(!items[id])throw Object.assign(new Error('x'),{code:'http_404'});return {...items[id]};},
  put:async(p,body)=>{const id=p.match(/MLU\d+/)[0];puts.push([id,body]);if(!stubborn.includes(id))items[id]={...items[id],...body};return {};}};
}
const vintage=(id,extra={})=>({id,seller_id:2341378249,status:'active',title:'Libro X',seller_custom_field:'AMADO-AR-9789502323060',price:1990,available_quantity:1,sale_terms:[{id:'MANUFACTURING_TIME'}],...extra});

test('sin --real no se escribe nada y otra cuenta nunca se toca',async()=>{
 const ml=fakeMl({MLU1:vintage('MLU1'),MLU2:vintage('MLU2',{seller_id:440298103})});
 const s=await run({ids:['MLU1','MLU2'],ml,real:false,log:()=>{}});
 assert.deepEqual(s.resultados,{se_pausaria:1,otra_cuenta_no_se_toca:1});assert.equal(ml.puts.length,0);
});

test('con --real: respalda completo, pausa sin cerrar ni borrar y verifica el estado final',async()=>{
 const ml=fakeMl({MLU1:vintage('MLU1',{catalog_listing:true,description_x:'dato'}),MLU3:vintage('MLU3',{status:'closed'}),MLU4:vintage('MLU4',{seller_id:440298103}),MLU5:vintage('MLU5',{status:'paused'})});
 const saved=[];
 const s=await run({ids:['MLU1','MLU3','MLU4','MLU5','MLU9'],ml,real:true,respaldo:async i=>saved.push(i),log:()=>{}});
 assert.deepEqual(ml.puts,[['MLU1',{status:'paused'}]]);
 assert.ok(!ml.puts.some(([,b])=>b.deleted||b.status==='closed'),'nunca cierra ni borra');
 assert.deepEqual(s.resultados,{pausada:2,ya_inactiva:1,otra_cuenta_no_se_toca:1,no_se_pudo_leer:1});
 assert.equal(saved.find(i=>i.id==='MLU1').description_x,'dato');
 assert.ok(!saved.some(i=>i.id==='MLU4'),'no respalda ni toca otra cuenta');
});

test('si ML acepta pero la publicación sigue activa, queda marcada sin resolver',async()=>{
 const ml=fakeMl({MLU1:vintage('MLU1')},{stubborn:['MLU1']});
 const s=await run({ids:['MLU1'],ml,real:true,log:()=>{}});
 assert.equal(s.resultados.sigue_activa,1);assert.deepEqual(s.sin_resolver,['MLU1']);
});

test('la lista aprobada tiene exactamente las 2725 publicaciones y sólo números MLU',async()=>{
 const ids=await readList(new URL('../../scripts/vintage-cloud/pausar-2026-11-09.txt',import.meta.url));
 assert.equal(ids.length,2725);assert.ok(ids.every(i=>/^MLU\d+$/.test(i)));
});

test('la sincronización de stock de Vintage no puede reactivar una publicación de la lista pausada',async()=>{
 const {pausadasIpSet}=await import('../../scripts/vintage-local/stock-sync.mjs');
 const set=await pausadasIpSet();
 assert.equal(set.size,2725);
 const src=await (await import('node:fs/promises')).readFile(new URL('../../scripts/vintage-local/stock-sync.mjs',import.meta.url),'utf8');
 // Acepta el conjunto del archivo solo o ampliado con las bloqueadas en D1 (pausadasIpSet(blockedIds)).
 assert.match(src,/desired_status==='active'&&\(await pausadasIpSet\([^)]*\)\)\.has\(String\(row\.item_id\)\)/);
});

test('el barrido previo encuentra riesgosas activas fuera de la lista (p. ej. la gemela de catálogo) y no cuenta las de la lista ni las inactivas',async()=>{
 const {sweepActive}=await import('../../scripts/vintage-cloud/pausar.mjs');
 const items={
  MLU1:{id:'MLU1',status:'active',title:'Dieci A1 - Libro + Ebook',catalog_listing:true,catalog_product_id:'MLU555',seller_custom_field:'AMADO-AR-9788861826885',attributes:[]},
  MLU2:{id:'MLU2',status:'active',title:'Dieci A1 - Libro + Ebook',catalog_listing:false,seller_custom_field:'AMADO-AR-9788861826885',attributes:[]},
  MLU3:{id:'MLU3',status:'active',title:'Rayuela',catalog_listing:true,seller_custom_field:'AMADO-AR-9789500000000',attributes:[{id:'BOOK_PUBLISHER',value_name:'Sudamericana'}]},
  MLU4:{id:'MLU4',status:'paused',title:'Libro Digital X',catalog_listing:false,seller_custom_field:'',attributes:[]},
  MLU5:{id:'MLU5',status:'active',title:'Arriviamo 3',catalog_listing:true,seller_custom_field:'AMADO-AR-9788853600000',attributes:[{id:'BOOK_PUBLISHER',value_name:'Eli Edizioni'}]},
 };
 const ml={get:async p=>{if(p.includes('/items/search'))return {results:Object.keys(items)};const ids=new URL('https://x'+p).searchParams.get('ids').split(',');return ids.map(id=>({code:200,body:items[id]}));}};
 const lines=[];
 const r=await sweepActive(ml,new Set(['MLU2']),{log:l=>lines.push(l)});
 assert.equal(r.activas_revisadas,5);
 assert.deepEqual(r.riesgosas_fuera_de_lista.map(x=>x.id).sort(),['MLU1','MLU5']);
 assert.ok(lines.some(l=>l.startsWith('FUERA_DE_LISTA\tMLU1\tebook\tcatalogo\tMLU555')));
});
