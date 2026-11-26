import test from 'node:test';
import assert from 'node:assert/strict';
import {readApi,recentResults,summarizeResult,TARGET_NAMES,scrub} from '../../scripts/monitoring/checkly-evidence.mjs';
const ID='00000000-0000-4000-8000-000000000001',now=Date.parse('2026-11-26T23:00:00Z');
test('paginated results are sorted by date, including an older first page',async()=>{
 let calls=0;
 const api=async p=>{
  const u=new URL(p,'https://api.checklyhq.com');assert.ok(u.searchParams.has('from'));assert.ok(u.searchParams.has('to'));calls++;
  if(!u.searchParams.has('nextId'))return{entries:[{id:'old',checkId:ID,startedAt:'2026-11-26T12:00:00Z'}],nextId:'cursor+one/='};
  assert.equal(u.searchParams.get('nextId'),'cursor+one/=');
  return{entries:[{id:'new',checkId:ID,startedAt:'2026-11-26T22:50:00Z'}],nextId:null};
 };
 const r=await recentResults(api,ID,{now});assert.equal(calls,2);assert.equal(r.complete,true);assert.deepEqual(r.rows.map(x=>x.id),['new','old']);
});
test('wrong checks and old rows cannot count as current evidence',async()=>{
 const r=await recentResults(async()=>({entries:[{id:'wrong',checkId:'other',startedAt:'2026-11-26T22:50:00Z'},{id:'old',checkId:ID,startedAt:'2026-11-22T22:50:00Z'}],nextId:null}),ID,{now});
 assert.equal(r.rows.length,0);
});
test('truncated pagination remains explicit',async()=>{const r=await recentResults(async()=>({entries:[],nextId:'next'}),ID,{now,maxPages:1});assert.equal(r.complete,false);});
test('browser evidence uses browserCheckResult and excludes API response body',()=>{
 const r=summarizeResult({browserCheckResult:{errors:['CATALOGO_SIN_FICHAS'],jobLog:'failed selector'},apiCheckResult:{response:{body:'PRIVATE'}}},{name:TARGET_NAMES[1]});
 assert.match(r.browserErrors,/CATALOGO_SIN_FICHAS/);assert.equal(r.browserLog,'failed selector');assert.equal(r.responseBody,null);
});
test('signature report retains assertion outcome and expected body, never headers',()=>{
 const r=summarizeResult({apiCheckResult:{response:{status:401,body:'{"error":"Firma inválida."}',headers:{Authorization:'secret'}},assertions:[{source:'STATUS_CODE',actual:401,result:false,error:''}]}},{name:TARGET_NAMES[0]});
 assert.equal(r.httpStatus,401);assert.match(r.responseBody,/Firma inválida/);assert.equal(r.assertions[0].result,false);assert.ok(!JSON.stringify(r).includes('secret'));
});
test('API reader sends only GET to allowed paths and strips signed URLs',async()=>{
 const calls=[],api=readApi({key:'test',fetchFn:async(u,o)=>{calls.push({u:String(u),o});return new Response('{}');}});
 await api('/v1/checks');assert.equal(calls[0].o.method,'GET');
 await assert.rejects(api('https://evil.test/v1/checks'),/READ_PATH_NOT_ALLOWED/);
 await assert.rejects(api('/v1/check-sessions/trigger'),/READ_PATH_NOT_ALLOWED/);
 assert.equal(calls.length,1);assert.equal(scrub('https://assets.test/trace.zip?token=secret'),'https://assets.test/trace.zip');
});
