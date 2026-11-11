import test from 'node:test';
import assert from 'node:assert/strict';
import {watch,watchSignals,brakeOn,releaseBrake,isIp,similarTo,makeReact,blockedIds,blockedIsbns} from '../../scripts/vintage-cloud/vigia-pi.mjs';
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

test('image-rights reports (PPPI6) count as IP, and a new open BPP case brakes with its due date',async t=>{
 assert.ok(isIp(inf('6','PPPI6','La publicación usa imágenes protegidas')));
 assert.ok(isIp(inf('7','X','Infringe derechos de autor')));
 const query=d1(t),mails=[];const send=async m=>{mails.push(m);return 'enviado';};
 const existing=[inf('old1','FOTOS')];
 await watch({query,getInfractions:pages(existing),getCases:async()=>[{id:'c1',current_status:'closed'}],send});
 assert.equal(mails.length,0);
 const r=await watch({query,getInfractions:pages(existing),getCases:async()=>[{id:'c1',current_status:'closed'},{id:'c2',current_status:'pending_seller_response',item_id:'MLU77',due_date:'2026-11-11'}],send});
 assert.equal(r.nuevas_pi,1);assert.equal(r.denuncias_abiertas,1);assert.equal(mails.length,1);
 assert.match(mails[0].texto,/Brand Protection Program/);assert.match(mails[0].texto,/2026-11-11/);
 assert.ok(await brakeOn(query));
 // Si la consulta de denuncias falla, no se frena por eso, pero se informa.
 await releaseBrake(query);
 const r2=await watch({query,getInfractions:pages(existing),getCases:async()=>{throw new Error('x');},send});
 assert.equal(r2.denuncias_abiertas,null);assert.equal(await brakeOn(query),null);
});

test('similar listings = same publisher or same IP pattern, only active ones, never the denounced itself',()=>{
 const den={id:'MLU1',title:'Dieci A1 - Libro + Ebook Interattivo',publisher:'Alma Edizioni'};
 const cands=[{id:'MLU1',status:'active',title:'x',publisher:'Alma Edizioni'},{id:'MLU2',status:'active',title:'Dieci B1',publisher:'Alma Edizioni'},{id:'MLU3',status:'active',title:'Nuovo Espresso + Ebook',publisher:'Otra'},{id:'MLU4',status:'paused',title:'Dieci A2',publisher:'Alma Edizioni'},{id:'MLU5',status:'active',title:'Cien años de soledad',publisher:'Sudamericana'}];
 assert.deepEqual(similarTo(den,cands).map(c=>c.id),['MLU2','MLU3']);
});

test('on a new IP report the watcher pauses the denounced listing and the similar ones, blocks them and says so in the mail',async t=>{
 const query=d1(t),mails=[],puts=[];const send=async m=>{mails.push(m);return 'enviado';};
 const items={MLU1:{id:'MLU1',title:'Dieci A1 - Libro + Ebook',status:'active',seller_id:2341378249,seller_custom_field:'AMADO-AR-9788861826885',attributes:[{id:'BOOK_PUBLISHER',value_name:'Alma Edizioni'}]},
  MLU2:{id:'MLU2',title:'Dieci B1',status:'active',seller_id:2341378249,seller_custom_field:'AMADO-AR-9788861826892',attributes:[{id:'BOOK_PUBLISHER',value_name:'Alma Edizioni'}]},
  MLU3:{id:'MLU3',title:'Rayuela',status:'active',seller_id:2341378249,seller_custom_field:'AMADO-AR-9789500000000',attributes:[{id:'BOOK_PUBLISHER',value_name:'Sudamericana'}]}};
 const ml={get:async p=>{if(p.includes('/items/search'))return {results:Object.keys(items)};const one=p.match(/^\/items\/(MLU\d+)/);if(one)return items[one[1]];const ids=new URL('https://x'+p).searchParams.get('ids').split(',');return ids.map(id=>({code:200,body:items[id]}));},put:async(p,b)=>{puts.push([p.match(/MLU\d+/)[0],b]);}};
 await watch({query,getInfractions:async()=>[],send});// baseline
 const r=await watch({query,getInfractions:async o=>o?[]:[inf('n1','COPIAS_REPLICAS','propiedad intelectual','MLU1')],getItemTitle:async()=>'Dieci A1 - Libro + Ebook',react:makeReact(ml,query),send});
 assert.equal(r.reaccion.pausadas.length,2);
 assert.deepEqual(puts.map(x=>x[0]).sort(),['MLU1','MLU2']);
 assert.deepEqual([...await blockedIds(query)].sort(),['MLU1','MLU2']);
 assert.deepEqual([...await blockedIsbns(query)].sort(),['9788861826885','9788861826892']);
 assert.match(mails[0].texto,/Se pausaron 2 publicaciones/);assert.ok(!/Responder desde la publicación/.test(mails[0].texto));
 assert.ok(await brakeOn(query));
});

test('a pagination block from Mercado Libre (total 0) is not an open case',async t=>{
 const query=d1(t);
 const r=await watch({query,getInfractions:pages([]),getCases:async()=>[{total:0,offset:0,limit:50}],send:async()=>'enviado'});
 assert.equal(r.denuncias_abiertas,0);
 const real=await watch({query,getInfractions:pages([]),getCases:async()=>[{id:'c1',current_status:'open',item_id:'MLU9',due_date:'2026-12-01'}],send:async()=>'enviado'});
 assert.equal(real.denuncias_abiertas,1,'un caso con id sigue contando');
});

test('an old BPP case seen for the first time is recorded without alarm; a recent one brakes',async t=>{
 const query=d1(t),mails=[],send=async m=>{mails.push(m);return 'enviado';},now=Date.parse('2026-11-10T12:00:00Z');
 await watch({query,getInfractions:pages([]),send,now});
 const old={case_id:1,item_id:'MLU1',current_status:'DOCUMENTATION_NOT_PRESENTED',date_created:'2026-10-01T10:00:00Z'};
 const r=await watch({query,getInfractions:pages([]),getCases:async()=>[old,{total:1,offset:0,limit:50}],send,now});
 assert.equal(r.nuevas_pi,0);assert.equal(mails.length,0);assert.equal(await brakeOn(query),null);
 const recent={case_id:2,item_id:'MLU2',current_status:'WAITING_DOCUMENTATION',date_created:'2026-11-10T09:00:00Z',due_date:'2026-11-17T09:00:00Z'};
 const r2=await watch({query,getInfractions:pages([]),getCases:async()=>[old,recent],send,now});
 assert.equal(r2.nuevas_pi,1);assert.equal(mails.length,1);assert.ok(await brakeOn(query));
});

test('BPP cases that were rejected, discarded or approved are not open cases',async t=>{
 const query=d1(t),now=Date.parse('2026-11-10T12:00:00Z'),mk=(i,s)=>({case_id:i,item_id:'MLU'+i,current_status:s,date_created:'2026-11-10T09:00:00Z'});
 await watch({query,getInfractions:pages([]),send:async()=>'enviado',now});
 const r=await watch({query,getInfractions:pages([]),getCases:async()=>[mk(1,'REJECTED'),mk(2,'DISCARDED'),mk(3,'DOCUMENTATION_APPROVED'),mk(4,'MEMBER_NOT_RESPOND'),mk(5,'WAITING_DOCUMENTATION')],send:async()=>'enviado',now});
 assert.equal(r.denuncias_abiertas,1);
});

const notice=(id,title,description='')=>({id,title,description,category:'ALERT'});
test('panel notices: the first read only learns; a new IP notice brakes with one alarm; another kind only mails',async t=>{
 const query=d1(t),mails=[],send=async m=>{mails.push(m);return 'enviado';},now=Date.parse('2026-11-10T12:00:00Z');
 const old=[notice('1','Retiramos algunas publicaciones porque incumplen la política de propiedad intelectual')];
 const first=await watchSignals({query,getNotices:async()=>old,send,now});
 assert.equal(first.avisos_nuevos,0);assert.equal(mails.length,0);assert.equal(await brakeOn(query),null);
 const again=await watchSignals({query,getNotices:async()=>old,send,now});
 assert.equal(again.avisos_nuevos,0);
 const other=await watchSignals({query,getNotices:async()=>[notice('2','Actualizamos nuestros términos'),...old],send,now});
 assert.equal(other.avisos_nuevos,1);assert.equal(mails.length,1);assert.equal(await brakeOn(query),null);
 const ip=await watchSignals({query,getNotices:async()=>[notice('3','Aviso','<p>Réplicas, falsificaciones y copias no autorizadas</p>'),notice('2','Actualizamos nuestros términos'),...old],send,now});
 assert.equal(ip.avisos_pi,1);assert.ok(await brakeOn(query));assert.match(mails.at(-1).asunto,/FRENADO/);
 await watchSignals({query,getNotices:async()=>[notice('3','Aviso','<p>Réplicas, falsificaciones y copias no autorizadas</p>'),notice('2','x'),...old],send,now});
 assert.equal(mails.length,2,'no repite el aviso');
});

test('reputation: one snapshot per day; mails only if the level changes or cancellations or claims pass the reference',async t=>{
 const query=d1(t),mails=[],send=async m=>{mails.push(m);return 'enviado';};
 const rep=(level,cancel,claims)=>({level_id:level,metrics:{sales:{completed:153},cancellations:{rate:cancel},claims:{rate:claims},delayed_handling_time:{rate:.007}}});
 const d1ms=Date.parse('2026-11-10T12:00:00Z'),d2=d1ms+86400000,d3=d2+86400000;
 let r=await watchSignals({query,getReputation:async()=>rep('5_green',.006,0),send,now:d1ms});
 assert.equal(r.reputacion.level,'5_green');assert.equal(mails.length,0);
 await watchSignals({query,getReputation:async()=>rep('5_green',.03,0),send,now:d1ms+3600000});
 assert.equal(mails.length,0,'el mismo día no se vuelve a evaluar');
 await watchSignals({query,getReputation:async()=>rep('5_green',.03,0),send,now:d2});
 assert.equal(mails.length,1);assert.match(mails[0].texto,/cancelaciones/);
 await watchSignals({query,getReputation:async()=>rep('4_light_green',.006,0),send,now:d3});
 assert.equal(mails.length,2);assert.match(mails[1].texto,/nivel pasó de 5_green a 4_light_green/);
});

test('catalog competition: one daily snapshot of a sample; it mails only when fewer listings carry the non-trusted-seller reason',async t=>{
 const query=d1(t),mails=[],send=async m=>{mails.push(m);return 'enviado';},d1ms=Date.parse('2026-11-11T12:00:00Z'),d2=d1ms+86400000,d3=d2+86400000;
 const comp=(nt,otro)=>async()=>({total:nt+otro,por_razon:{'listed|non_trusted_seller':nt,...(otro?{'winning|sin_razon':otro}:{})}});
 const a=await watchSignals({query,getCompetencia:comp(20,0),send,now:d1ms});
 assert.equal(a.competencia.total,20);assert.equal(mails.length,0);
 await watchSignals({query,getCompetencia:comp(10,10),send,now:d1ms+3600000});
 assert.equal(mails.length,0,'el mismo día no se vuelve a evaluar');
 await watchSignals({query,getCompetencia:comp(20,0),send,now:d2});
 assert.equal(mails.length,0,'sin cambio no avisa');
 await watchSignals({query,getCompetencia:comp(12,8),send,now:d3});
 assert.equal(mails.length,1);assert.match(mails[0].texto,/60 %/);
});
