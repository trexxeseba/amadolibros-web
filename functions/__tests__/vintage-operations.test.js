import test from 'node:test';
import assert from 'node:assert/strict';
import {createVintageOperations,verifyVintageOperations,VINTAGE_OPERATIONS_PATH} from '../operations/vintage.js';
import {sha256,PublicationError} from '../../worker-sync/publication-policy.js';
import {OPERATIONS_ISSUER} from '../../worker-sync/operations-read.js';
const pair=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const publicKey=await crypto.subtle.exportKey('jwk',pair.publicKey),run_id='23413782-4900-4000-8000-000000000005';
async function request(action,args={},overrides={},rawOverride){
 const raw=JSON.stringify({action,args}),seconds=Math.floor(Date.now()/1000);
 const c={v:1,iss:OPERATIONS_ISSUER,aud:'amado-vintage-pilot',seller_id:'2341378249',path:VINTAGE_OPERATIONS_PATH,method:'POST',iat:seconds,exp:seconds+60,jti:crypto.randomUUID(),body_sha256:await sha256(raw),...overrides};
 const encoded=Buffer.from(JSON.stringify(c)).toString('base64url'),sig=Buffer.from(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},pair.privateKey,new TextEncoder().encode(encoded))).toString('base64url');
 return new Request('https://www.amadolibros.com'+VINTAGE_OPERATIONS_PATH,{method:'POST',headers:{Authorization:'Amado-Signature '+encoded+'.'+sig,'Content-Type':'application/json'},body:rawOverride??raw});
}
function fixture(){
 const calls=[],nonces=new Set();
 const state={run:{id:run_id,state:'preflight'},progress:{indexed:100,index_complete:false,lease_until:500,backoff_until:0},summary:{counts:[{state:'pending',n:1000}],index:{scroll_id:'private-cursor'}},sample:[{isbn:'test',title:'Book',price:100,state:'validated',payload:{private:'raw-payload'}}],policy_hash:'a'.repeat(64),sample_hash:'b'.repeat(64)};
 const pilot=Object.fromEntries(['snapshot','sources','prepare','advance','approve','publishApproved'].map(name=>[name,async()=>{calls.push(name);return state;}]));
 const handle=createVintageOperations({pilot,verify:(req,raw)=>verifyVintageOperations(req,raw,{publicKey}),consume:async(_,nonce)=>{if(nonces.has(nonce.id))throw new PublicationError('request_already_used',409);nonces.add(nonce.id);}});
 return {calls,handle:req=>handle({request:req,env:{APP_ENV:'production'}})};
}
test('signed Vintage status is read-only and excludes scan cursors and raw payloads',async()=>{
 const f=fixture(),r=await f.handle(await request('status')),data=await r.json();
 assert.equal(r.status,200);assert.equal(data.seller_id,'2341378249');assert.equal(data.read_only,true);assert.equal(data.progress.indexed,100);assert.deepEqual(f.calls,['snapshot']);
 assert.ok(!JSON.stringify(data).includes('private-cursor'));assert.ok(!JSON.stringify(data).includes('raw-payload'));assert.equal(data.progress.lease_until,undefined);
});
test('Libros, wrong audience, expired claims or tampered bodies never reach the pilot',async()=>{
 const f=fixture();
 for(const [claims,raw] of [[{seller_id:'440298103'}],[{aud:'amado-mercadolibre-publication'}],[{exp:0}],[{},JSON.stringify({action:'approve',args:{run_id}})]])assert.equal((await f.handle(await request('status',{},claims,raw))).status,401);
 assert.deepEqual(f.calls,[]);
});
test('validation dispatches only preflight and rejects replay and foreign run IDs',async()=>{
 const f=fixture(),req=await request('validate',{run_id}),duplicate=req.clone();
 assert.equal((await f.handle(req)).status,200);assert.equal((await f.handle(duplicate)).status,409);assert.deepEqual(f.calls,['advance']);
 assert.equal((await f.handle(await request('validate',{run_id:crypto.randomUUID()}))).status,404);
 assert.equal((await f.handle(await request('validate',{run_id,seller_id:'440298103'}))).status,400);
});
test('the signed connector cannot approve even with valid exact sample hashes',async()=>{
 const f=fixture();assert.equal((await f.handle(await request('approve',{run_id}))).status,400);assert.deepEqual(f.calls,[]);
 assert.equal((await f.handle(await request('approve',{run_id,policy_hash:'a'.repeat(64),sample_hash:'b'.repeat(64)}))).status,400);assert.deepEqual(f.calls,[]);
});
test('unsigned and oversized requests cannot invoke pilot actions',async()=>{
 const f=fixture();
 assert.equal((await f.handle(new Request('https://www.amadolibros.com'+VINTAGE_OPERATIONS_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}))).status,401);
 assert.equal((await f.handle(new Request('https://www.amadolibros.com'+VINTAGE_OPERATIONS_PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:'x'.repeat(4097)}))).status,413);assert.deepEqual(f.calls,[]);
});
