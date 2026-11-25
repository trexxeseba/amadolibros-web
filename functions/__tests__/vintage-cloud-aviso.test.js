import test from 'node:test';
import assert from 'node:assert/strict';
import {decide,run,uyDate} from '../../scripts/vintage-cloud/aviso.mjs';
import {openDatabase} from '../../scripts/vintage-local/db.mjs';

const noon=Date.parse('2026-11-06T15:00:00Z'),justAfterMidnight=Date.parse('2026-11-07T03:20:00Z');
const ok={accion:'publicar',estado:'time_slice_done',publicacion:{estado:'time_slice_done',altas_de_esta_corrida:300,publicados_total:17000},freno:{altas_hoy:2000,tope_diario:8000}};

test('a normal run at noon sends nothing; a failure or 0 altas below the cap alerts',()=>{
 assert.deepEqual(decide({report:ok,failed:false,now:noon}),[]);
 assert.equal(decide({report:null,failed:true,now:noon})[0].id,'fallo');
 const stuck={...ok,publicacion:{...ok.publicacion,altas_de_esta_corrida:0}};
 assert.equal(decide({report:stuck,failed:false,now:noon})[0].id,'sin_altas');
 // 0 altas por haber llegado al tope: no es una traba.
 assert.deepEqual(decide({report:{...stuck,freno:{altas_hoy:8000,tope_diario:8000}},failed:false,now:noon}),[]);
 assert.deepEqual(decide({report:{...stuck,estado:'tope_diario_alcanzado'},failed:false,now:noon}),[]);
 // keepalive (Precio Ganador corriendo, por ejemplo) no avisa.
 assert.deepEqual(decide({report:{accion:'keepalive',estado:'token_vigente'},failed:false,now:noon}),[]);
});

test('after midnight in Montevideo the previous day closes once',()=>{
 const d=decide({report:ok,failed:false,now:justAfterMidnight});
 assert.deepEqual(d.map(x=>x.id),['cierre-2026-11-06']);
 assert.equal(uyDate(justAfterMidnight),'2026-11-07');
});

async function fixture(t){
 const db=openDatabase(':memory:');t.after(()=>db.close());
 const query=async(sql,params=[])=>{const st=db.prepare(sql).bind(...params);return /^\s*SELECT/i.test(sql)?(await st.all()).results:(await st.run(),[]);};
 await query('CREATE TABLE ml_vintage_pub_receipts (seller_id TEXT,isbn TEXT,state TEXT,item_id TEXT,run_id TEXT,created_at INTEGER,updated_at INTEGER)');
 return {query};
}

test('the daily close counts the day in Montevideo and is sent only once',async t=>{
 const f=await fixture(t),mails=[];
 const day=Date.parse('2026-11-06T03:00:00Z');
 for(let i=0;i<7;i++)await f.query("INSERT INTO ml_vintage_pub_receipts VALUES('2341378249',?,'published','MLU1','r',?,0)",[String(i),day+i*3600000]);
 await f.query("INSERT INTO ml_vintage_pub_receipts VALUES('2341378249','old','published','MLU1','r',?,0)",[day-1000]);
 await f.query("INSERT INTO ml_vintage_pub_receipts VALUES('2341378249','u','uncertain',NULL,'r',?,0)",[day+5000]);
 const send=async m=>{mails.push(m);return 'enviado';};
 await run({report:ok,failed:false,query:f.query,now:justAfterMidnight,send});
 await run({report:ok,failed:false,query:f.query,now:justAfterMidnight+3600000,send});
 assert.equal(mails.length,1);
 assert.match(mails[0].asunto,/^7 altas el 06\/11$/);
 assert.match(mails[0].texto,/Total publicado por la campaña: 13/);
});

test('a stuck run alerts at most once every 3 hours',async t=>{
 const f=await fixture(t),mails=[];const send=async m=>{mails.push(m);return 'enviado';};
 await run({report:null,failed:true,query:f.query,now:noon,send});
 await run({report:null,failed:true,query:f.query,now:noon+3600000,send});
 await run({report:null,failed:true,query:f.query,now:noon+3*3600000+1,send});
 assert.equal(mails.length,2);
 assert.ok(mails.every(m=>!/token|secret/i.test(m.texto)));
});
