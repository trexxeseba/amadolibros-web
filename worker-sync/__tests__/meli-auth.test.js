import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {createMeliAuth,MeliAuthError,REFRESH_MARGIN_MS} from '../meli-auth.js';

function kv(initial={}){const store=new Map(Object.entries(initial)),writes=[];return {store,writes,async get(k){return store.get(k)??null;},async put(k,v){writes.push(k);store.set(k,v);},async delete(k){store.delete(k);}};}
async function fixture(t,{responses,legacy='refresh-0',expiresIn=21600}={}){
 const dir=await mkdtemp(join(tmpdir(),'amado-auth-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'auth.sqlite')),clock={value:1_700_000_000_000},calls=[];let issued=0;
 const fetcher=responses??(async(url,options)=>{
  const body=Object.fromEntries(new URLSearchParams(options.body));calls.push(body.refresh_token);
  assert.equal(url,'https://api.mercadolibre.com/oauth/token');assert.equal(options.redirect,'manual');
  await new Promise(r=>setTimeout(r,20));issued++;
  return Response.json({access_token:`access-${issued}`,refresh_token:`refresh-${issued}`,expires_in:expiresIn,token_type:'Bearer'});
 });
 const legacyKv=kv(legacy?{'auth:refresh_token':legacy}:{});
 const env={ORDERS_DB:db,AMADO_KV:legacyKv,APP_ID:'4741021817925208',CLIENT_SECRET:'secret-test'};
 const auth=createMeliAuth({fetcher,now:()=>clock.value,sleep:async()=>{await new Promise(r=>setTimeout(r,5));},random:()=>0});
 return {db,env,auth,clock,calls,legacyKv,issued:()=>issued};
}

test('bootstraps once from legacy KV, stores the real expires_in and never refreshes while the token is valid',async t=>{
 const f=await fixture(t);
 assert.equal(await f.auth.getAccessToken(f.env),'access-1');assert.deepEqual(f.calls,['refresh-0']);
 const row=await f.db.prepare('SELECT * FROM ml_oauth').first();
 assert.equal(row.refresh_token,'refresh-1');assert.equal(row.access_expires_at,f.clock.value+21600*1000);assert.equal(row.lock_until,0);assert.equal(row.lock_token,null);
 f.clock.value+=3*3600*1000;assert.equal(await f.auth.getAccessToken(f.env),'access-1');assert.equal(f.issued(),1);
 assert.deepEqual(f.legacyKv.writes,[]);assert.equal(f.legacyKv.store.get('auth:refresh_token'),'refresh-0');
 const state=await f.auth.state(f.env);assert.equal(state.bootstrapped,true);assert.equal(state.access_token_valid,true);assert.doesNotMatch(JSON.stringify(state),/access-1|refresh-/);
});
test('an expired or nearly expired token is refreshed with the single-use refresh token',async t=>{
 const f=await fixture(t);await f.auth.getAccessToken(f.env);
 f.clock.value+=21600*1000-REFRESH_MARGIN_MS+1;assert.equal(await f.auth.getAccessToken(f.env),'access-2');assert.deepEqual(f.calls,['refresh-0','refresh-1']);
 f.clock.value+=48*3600*1000;assert.equal(await f.auth.getAccessToken(f.env),'access-3');assert.equal(f.calls.at(-1),'refresh-2');
 assert.equal((await f.db.prepare('SELECT refresh_token FROM ml_oauth').first()).refresh_token,'refresh-3');
});
test('concurrent callers perform exactly one refresh and share the result',async t=>{
 const f=await fixture(t);
 const tokens=await Promise.all([f.auth.getAccessToken(f.env),f.auth.getAccessToken(f.env),f.auth.getAccessToken(f.env)]);
 assert.deepEqual(tokens,['access-1','access-1','access-1']);assert.equal(f.issued(),1);
 assert.equal((await f.db.prepare('SELECT lock_until FROM ml_oauth').first()).lock_until,0);
});
test('missing expires_in is never assumed: the token is used once and renewed on the next call',async t=>{
 const f=await fixture(t,{expiresIn:null});
 assert.equal(await f.auth.getAccessToken(f.env),'access-1');assert.equal(await f.auth.getAccessToken(f.env),'access-2');
});
test('invalid_grant is not retryable, is recorded without secrets and releases the lock',async t=>{
 const f=await fixture(t,{responses:async()=>Response.json({error:'invalid_grant',message:'refresh-0 is invalid'},{status:400})});
 await assert.rejects(()=>f.auth.getAccessToken(f.env),error=>{assert.ok(error instanceof MeliAuthError);assert.equal(error.code,'auth_invalid_grant');assert.equal(error.retryable,false);assert.equal(error.status,401);return true;});
 const row=await f.db.prepare('SELECT * FROM ml_oauth').first();assert.equal(row.last_error,'auth_invalid_grant');assert.equal(row.lock_until,0);assert.equal(row.refresh_token,'refresh-0');
});
test('upstream 5xx, 429 and transport failures are retryable and keep the stored refresh token',async t=>{
 for(const responder of [async()=>Response.json({error:'server'},{status:503}),async()=>new Response('',{status:429,headers:{'retry-after':'30'}}),async()=>{throw Error('refresh-0 leaked?');}]){
  const f=await fixture(t,{responses:responder});
  await assert.rejects(()=>f.auth.getAccessToken(f.env),error=>{assert.ok(error instanceof MeliAuthError);assert.equal(error.retryable,true);assert.equal(error.status,503);assert.doesNotMatch(error.message,/refresh-0/);return true;});
  const row=await f.db.prepare('SELECT * FROM ml_oauth').first();assert.equal(row.refresh_token,'refresh-0');assert.equal(row.lock_until,0);
 }
});
test('a 401 from the API invalidates only the current access token and the next call renews',async t=>{
 const f=await fixture(t);const first=await f.auth.getAccessToken(f.env);
 await f.auth.invalidateAccessToken(f.env,'another-token');assert.equal(await f.auth.getAccessToken(f.env),first);
 await f.auth.invalidateAccessToken(f.env,first);assert.equal(await f.auth.getAccessToken(f.env),'access-2');assert.equal(f.issued(),2);
});
test('without a bootstrapped refresh token or configuration the error is explicit and not retryable',async t=>{
 const f=await fixture(t,{legacy:null});
 await assert.rejects(()=>f.auth.getAccessToken(f.env),error=>error.code==='auth_not_bootstrapped'&&error.retryable===false);
 await assert.rejects(()=>f.auth.getAccessToken({...f.env,CLIENT_SECRET:''}),error=>error.code==='auth_not_configured');
 await assert.rejects(()=>f.auth.getAccessToken({APP_ID:'4741021817925208',CLIENT_SECRET:'x'}),error=>error.code==='auth_storage_not_configured');
});
