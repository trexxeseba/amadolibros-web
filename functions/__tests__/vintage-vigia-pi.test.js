import test from 'node:test';
import assert from 'node:assert/strict';
import {watch,brakeOn,releaseBrake,isIp} from '../../scripts/vintage-cloud/vigia-pi.mjs';
import {openDatabase} from '../../scripts/vintage-local/db.mjs';

function d1(t){const db=openDatabase(':memory:');t.after(()=>db.close());return async(sql,params=[])=>{const st=db.prepare(sql).bind(...params);return /^\s*SELECT/i.test(sql)?(await st.all()).results:(await st.run(),[]);};}
const inf=(id,sub,reason='',item='MLU1')=>({id,filter_subgroup:sub,reason,element_id:item,date_created:'2026-11-09T10:00:00-0400'});
const pages=list=>async offset=>list.slice(offset,offset+10);

test('IP infractions are recognised by subgroup or reason; photo ones are not',()=>{
 assert.ok(isIp(inf('1','COPIAS_REPLICAS')));assert.ok(isIp(inf('2','PI_FAKES')));
 assert.ok(isIp(inf('3','OTRO','Afectamos tu publicación porque al parecer incumple con nuestras políticas de propiedad intelectual.')));
 assert.ok(isIp(inf('4','X','Detectamos que el producto no era original.')));
 assert.equal(isIp(inf('5','FOTOS','La portada tiene logos y/o textos.')),false);
});

test('the first run only learns the existing infractions; a new IP one later brakes and sends ONE alarm',async t=>{
 const query=d1(t),mails=[];const send=async m=>{mails.push(m);return 'enviado';};
 const existing=Array.from({length:25},(_,i)=>inf('old'+i,i%2?'FOTOS':'COPIAS_REPLICAS'));
 const first=await watch({query,getInfractions:pages(existing),send});
 assert.equal(first.baseline,true);assert.equal(mails.length,0);assert.equal(await brakeOn(query),null);
 // Aparece una de fotos: nada.
 await watch({query,getInfractions:pages([inf('new1','FOTOS','fondo blanco'),...existing]),send});
 assert.equal(mails.length,0);assert.equal(await brakeOn(query),null);
 // Aparece una de propiedad intelectual: freno y alarma.
 const r=await watch({query,getInfractions:pages([inf('new2','COPIAS_REPLICAS','propiedad intelectual','MLU999'),inf('new1','FOTOS'),...existing]),getItemTitle:async()=>'Libro X',send});
 assert.equal(r.nuevas_pi,1);assert.equal(mails.length,1);assert.match(mails[0].asunto,/ALARMA.*FRENADO/);assert.match(mails[0].texto,/Libro X \(MLU999\)/);
 assert.ok(await brakeOn(query));
 // La misma no vuelve a avisar.
 await watch({query,getInfractions:pages([inf('new2','COPIAS_REPLICAS'),...existing]),send});
 assert.equal(mails.length,1);assert.ok(await brakeOn(query),'the brake stays on until released');
 await releaseBrake(query);assert.equal(await brakeOn(query),null);
});
