import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteD1} from './helpers/sqlite-d1.js';
import {createMeliAuth,MeliAuthError} from '../meli-auth.js';
import {handlePricingToken,sameSecret,PRICING_TOKEN_PATH} from '../pricing-token.js';

const SECRET='p'.repeat(40), SYNC='s'.repeat(40), NOW=1_700_000_000_000;
const req=(auth,method='GET')=>new Request('https://w.example'+PRICING_TOKEN_PATH,{method,headers:auth?{Authorization:auth}:{}});

async function fixture(t,{expiresIn=21600}={}){
 const dir=await mkdtemp(join(tmpdir(),'pricing-token-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const db=sqliteD1(join(dir,'d1.sqlite')),calls=[];
 const fetcher=async(url,o)=>{calls.push(Object.fromEntries(new URLSearchParams(o.body)).refresh_token);return Response.json({access_token:`access-${calls.length}`,refresh_token:`refresh-${calls.length}`,expires_in:expiresIn});};
 const auth=createMeliAuth({fetcher,now:()=>NOW,sleep:async()=>{},random:()=>0});
 const env={ORDERS_DB:db,APP_ID:'4741021817925208',CLIENT_SECRET:'c',USER_ID:'440298103',SYNC_SECRET:SYNC,PRICING_TOKEN_SECRET:SECRET,AMADO_KV:{get:async()=>'refresh-0'}};
 return {env,calls,opts:{getAccessToken:e=>auth.getAccessToken(e),now:()=>NOW}};
}

test('sin PRICING_TOKEN_SECRET la ruta no existe (404)',async t=>{
 const f=await fixture(t);delete f.env.PRICING_TOKEN_SECRET;
 const r=await handlePricingToken(req('Bearer '+SECRET),f.env,f.opts);assert.equal(r.status,404);assert.deepEqual(f.calls,[]);
});
test('SYNC_SECRET no abre esta ruta, y sin credencial tampoco',async t=>{
 const f=await fixture(t);
 for(const a of ['Bearer '+SYNC,null,'Bearer ','Basic '+SECRET,'Bearer '+SECRET+'x']){const r=await handlePricingToken(req(a),f.env,f.opts);assert.equal(r.status,401,String(a));}
 assert.deepEqual(f.calls,[]);
});
test('si PRICING_TOKEN_SECRET es igual a SYNC_SECRET se niega (configuración inválida)',async t=>{
 const f=await fixture(t);f.env.PRICING_TOKEN_SECRET=SYNC;
 assert.equal((await handlePricingToken(req('Bearer '+SYNC),f.env,f.opts)).status,500);
});
test('solo GET',async t=>{const f=await fixture(t);assert.equal((await handlePricingToken(req('Bearer '+SECRET,'POST'),f.env,f.opts)).status,405);});
test('entrega el access token con expires_in real y nunca el refresh token',async t=>{
 const f=await fixture(t,{expiresIn:20000});
 const r=await handlePricingToken(req('Bearer '+SECRET),f.env,f.opts);
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const text=await r.text(),b=JSON.parse(text);
 assert.equal(b.access_token,'access-1');assert.equal(b.expires_in,20000);assert.equal(b.user_id,'440298103');
 assert.doesNotMatch(text,/refresh/);assert.deepEqual(Object.keys(b).sort(),['access_token','expires_at','expires_in','token_type','user_id']);
 // Una segunda llamada reutiliza el token vigente: no renueva.
 await handlePricingToken(req('Bearer '+SECRET),f.env,f.opts);assert.equal(f.calls.length,1);
});
test('llamadas simultáneas renuevan una sola vez (lock del gestor único)',async t=>{
 const f=await fixture(t);
 const rs=await Promise.all(Array.from({length:6},()=>handlePricingToken(req('Bearer '+SECRET),f.env,f.opts)));
 assert.ok(rs.every(r=>r.status===200));assert.equal(f.calls.length,1);
});
test('errores del gestor salen tipados, sin token',async t=>{
 const f=await fixture(t);
 const r=await handlePricingToken(req('Bearer '+SECRET),f.env,{getAccessToken:async()=>{throw new MeliAuthError('auth_invalid_grant',{status:401,retryable:false});},now:()=>NOW});
 assert.equal(r.status,502);assert.deepEqual(await r.json(),{error:'auth_invalid_grant',retryable:false});
});
test('sameSecret',()=>{assert.equal(sameSecret('a','a'),true);assert.equal(sameSecret('a','b'),false);assert.equal(sameSecret('',''),false);assert.equal(sameSecret('ab','a'),false);});
