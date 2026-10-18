import test from 'node:test';
import assert from 'node:assert/strict';
import {deflateRawSync} from 'node:zlib';
import {readSelectedStock,sourceDate} from '../../astro-front/public/assets/meli-vintage-xlsx.mjs';
import {createVintageStockUpload} from '../panel/meli-vintage-stock.js';
import {createVintagePilotPage} from '../panel/meli-vintage-piloto.js';
import {createSessionToken,deriveSessionSecret,sessionCookieHeader} from '../_shared/panel-auth.js';
const origin='https://www.amadolibros.com',url=origin+'/panel/meli-vintage-stock';
const isbns=['9786075272795','9788410235861','9789502323060','9789502418513','9789878136912'];
const xml=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
// Tiny in-memory XLSX fixture, with real ZIP directory and DEFLATE entries.
function zip(files){
 const locals=[],central=[];let offset=0;
 for(const [name,text] of Object.entries(files)){
  const path=Buffer.from(name),raw=Buffer.from(text),data=deflateRawSync(raw),local=Buffer.alloc(30),entry=Buffer.alloc(46);
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(data.length,18);local.writeUInt32LE(raw.length,22);local.writeUInt16LE(path.length,26);
  entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(8,10);entry.writeUInt32LE(data.length,20);entry.writeUInt32LE(raw.length,24);entry.writeUInt16LE(path.length,28);entry.writeUInt32LE(offset,42);
  locals.push(local,path,data);central.push(entry,path);offset+=local.length+path.length+data.length;
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(central.length/2,8);end.writeUInt16LE(central.length/2,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
 return Buffer.concat([...locals,directory,end]);
}
function workbook({duplicate=false,missing=false,stock='+2',priceOnly=false,date='18/10/2026 01:04:23'}={}){
 const headers=priceOnly?['ISBN','Título','PVP','Fecha']:['ISBN','Título','Precio','Disponibilidad','Peso','Autor','Editorial'];
 const strings=['Pagina : 1 - '+date,...headers,'Libro & prueba','Autor','Editorial'];
 const rows=[['Pagina : 1 - '+date],[],[],headers,...isbns.slice(0,missing?4:5).map(isbn=>[isbn,'Libro & prueba','27700',stock,'.3','Autor','Editorial'])];
 if(duplicate)rows.push(rows[4]);
 const sheet='<worksheet><sheetData>'+rows.map((row,i)=>'<row r="'+(i+1)+'">'+row.map((value,j)=>{
  const index=strings.indexOf(value);return '<c r="'+String.fromCharCode(65+j)+(i+1)+'"'+(index>=0?' t="s"':'')+'><v>'+(index>=0?index:xml(value))+'</v></c>';
 }).join('')+'</row>').join('')+'</sheetData></worksheet>';
 return zip({'xl/sharedStrings.xml':'<sst>'+strings.map(s=>'<si><t>'+xml(s)+'</t></si>').join('')+'</sst>','xl/worksheets/sheet1.xml':sheet});
}

test('browser reader extracts exactly five rows, real source date and decoded shared strings',()=>{
 const result=readSelectedStock(workbook(),isbns);
 assert.equal(result.source_date,'2026-10-18T01:04:23-03:00');assert.equal(result.rows.length,5);assert.deepEqual(result.rows.map(r=>r.isbn),isbns);assert.equal(result.rows[0].title,'Libro & prueba');assert.equal(result.rows[0].weightKg,.3);
 assert.equal(sourceDate('Pagina 25/8/2026 01:04:11'),'2026-08-25T01:04:11-03:00');
 assert.throws(()=>sourceDate('31/2/2026 01:00:00'),/invalid_supplier_date/);
});

test('browser reader refuses price lists, missing books, duplicates, missing stock and corrupt ZIP',()=>{
 for(const [options,code] of [[{priceOnly:true},'stock_columns_or_date_missing'],[{missing:true},'selected_isbn_missing'],[{duplicate:true},'duplicate_selected_isbn'],[{stock:'0'},'selected_book_without_stock']])assert.throws(()=>readSelectedStock(workbook(options),isbns),new RegExp(code));
 assert.throws(()=>readSelectedStock(Buffer.from('invalid zip'),isbns),/invalid_or_oversized_workbook/);
});

async function session(){const env={APP_ENV:'production',PANEL_PASSWORD:'a-test-password-long-enough'};return {env,cookie:sessionCookieHeader(await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD))).split(';')[0]};}
test('manual stock endpoint requires owner session, same-origin JSON and a bounded body',async()=>{
 const {env,cookie}=await session();let calls=0;
 const endpoint=createVintageStockUpload({pilot:{async refreshStock(e,args){calls++;assert.deepEqual(args,{test:true});return {updated:true};}}});
 assert.equal((await endpoint({env,request:new Request(url,{method:'POST',body:'{}'})})).status,401);
 assert.equal((await endpoint({env,request:new Request(url,{method:'POST',headers:{cookie,origin:'https://evil.invalid','content-type':'application/json'},body:'{}'})})).status,403);
 assert.equal((await endpoint({env,request:new Request(url,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'x'.repeat(65537)})})).status,413);
 assert.equal(calls,0);
 const response=await endpoint({env,request:new Request(url,{method:'POST',headers:{cookie,origin,'content-type':'application/json'},body:'{"test":true}'})});
 assert.equal(response.status,200);assert.equal((await response.json()).publication_writes,false);assert.equal(calls,1);
});

test('expired pilot shows upload and expiry clearly, without an approval or publishing button',async()=>{
 const {env,cookie}=await session();
 const state={run:{id:'run',state:'ready'},display_state:'stock_stale',stock_fresh:false,can_upload:true,can_approve:false,feed:{id:'feed',source_date:'2026-10-17T01:04:23-03:00'},sample_hash:'hash',progress:{index_complete:true,indexed:1747},sample:isbns.map(isbn=>({isbn,title:'Libro',price:1450,state:'validated'})),summary:{counts:[{state:'validated',n:5}]},issues:[],policy:{supplierDiscount:.25,margin:.23,mlFee:.17,additionalPricePct:0,availabilityDays:18},stock_diagnostics:{automatic:{checked_at:Date.now(),state:'failed',source_date:'2026-08-25T01:04:11-03:00',error_code:'supplier_stock_stale_or_future'}}};
 const page=createVintagePilotPage({pilot:{snapshot:async()=>state}}),response=await page({env,request:new Request(origin+'/panel/meli-vintage-piloto',{headers:{cookie}})}),html=await response.text();
 assert.match(html,/Stock vencido/);assert.match(html,/Cargar Excel y actualizar estos 5 ISBN/);assert.match(html,/Última descarga automática/);assert.match(html,/Vence:/);assert.doesNotMatch(html,/Aprobar precios y publicar/);assert.doesNotMatch(html,/Estado: <strong>lista para revisar/);
 assert.match(response.headers.get('content-security-policy'),/worker-src 'self'/);
});
