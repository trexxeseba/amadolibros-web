import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {runCardStages,signedS3Request} from '../r2-card-stage.mjs';
import {CARD_RECIPES} from '../build-permanent-variants.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

async function fixture() {
  const masters=Array.from({length:2788},(_,i)=>({file:i.toString(16).padStart(64,'0')+'.png',size:100}));
  const originals=new Map();
  for(let i=0;i<10;i++) {
    const bytes=await sharp({create:{width:60+i,height:90+i,channels:3,background:{r:i*20,g:50,b:100}}}).png().toBuffer();
    masters[i]={file:sha(bytes)+'.png',size:bytes.length}; originals.set('covers/v1/objects/'+masters[i].file,bytes);
  }
  const plan={schema:'active-card-variants-v1',bucket:'amadolibros-images-production',
    baseline:'29c5dce82ce807fdcd58d3c49c21fc64dc2b5cea',recipes:[...CARD_RECIPES],masters,masters_sha256:sha(JSON.stringify(masters))};
  const existing=await sharp({create:{width:60,height:90,channels:3,background:'#fff'}}).webp().toBuffer();
  const stored=new Map(), writes=[], touches=[];
  const s3=async(method,key,body,headers)=>{
    touches.push([method,key]);
    if(originals.has(key)) {assert.equal(method,'GET');return new Response(originals.get(key));}
    const match=/^covers\/variants\/v1\/([a-f0-9]{64})\/(v1-(240|360|480)-q85)\.webp$/.exec(key);
    assert.ok(match);const [,hash,id]=match;
    if(method==='PUT') {
      assert.equal(headers['if-none-match'],'*'); assert.ok(!stored.has(key));
      stored.set(key,{body,headers}); writes.push(key);return new Response(null,{status:200});
    }
    assert.equal(method,'GET');
    const object=stored.get(key);
    if(object) return new Response(object.body,{headers:object.headers});
    if(originals.has('covers/v1/objects/'+hash+'.png')) return new Response(null,{status:404});
    return new Response(existing,{headers:{'content-type':'image/webp','x-amz-meta-master_sha256':hash,'x-amz-meta-recipe':id,
      'x-amz-meta-sha256':sha(existing),'x-amz-meta-width':'60','x-amz-meta-height':'90','x-amz-meta-source_width':'60','x-amz-meta-source_height':'90'}});
  };
  return {plan,s3,stored,writes,touches};
}

test('pilot validates 30 stored variants before remaining; retry creates nothing',async()=>{
  const f=await fixture();let pilotPassed=false,saves=0;
  const s3=async(...args)=>{
    const hash=args[1].split('/')[3];
    if(!f.plan.masters.slice(0,10).some(m=>m.file.startsWith(hash)) && args[1].startsWith('covers/variants')) assert.ok(pilotPassed);
    return f.s3(...args);
  };
  const run=()=>runCardStages({plan:f.plan,s3,sharp,approvedDigest:f.plan.masters_sha256,
    checkpoint:async state=>{saves++;if(state.pilot_passed)pilotPassed=true;},
    report:row=>assert.equal(row.verified_variants,30)});
  const first=await run();assert.equal(first.stage,'completed');assert.equal(first.created,30);
  assert.equal(Object.keys(first.completed).length,8364);assert.equal(f.writes.length,30);assert.ok(saves>=8364);
  const second=await run();assert.equal(second.created,0);assert.equal(f.writes.length,30);
});

test('bad stored metadata stops pilot, preserves checkpoint and never touches remaining masters',async()=>{
  const f=await fixture();let saved;
  const s3=async(...args)=>{
    const response=await f.s3(...args);
    if(args[0]==='GET' && f.stored.has(args[1])) response.headers.set('x-amz-meta-recipe','wrong');
    return response;
  };
  await assert.rejects(runCardStages({plan:f.plan,s3,sharp,approvedDigest:f.plan.masters_sha256,
    checkpoint:async state=>{saved=structuredClone(state);}}),/generation-stage-failed/);
  assert.equal(saved.pilot_passed,false);assert.equal(saved.stage,'stopped');
  const hashes=new Set(f.plan.masters.slice(0,10).map(m=>m.file.slice(0,64)));
  assert.ok(f.touches.filter(([,key])=>key.startsWith('covers/variants')).every(([,key])=>hashes.has(key.split('/')[3])));
});

test('S3 signature includes conditional write and metadata, sends credentials only in authorization',()=>{
  const signed=signedS3Request({account:'a'.repeat(32),accessKey:'b'.repeat(32),secretKey:'secret',bucket:'bucket',
    key:'covers/variants/v1/test.webp',method:'PUT',body:Buffer.from('webp'),headers:{'if-none-match':'*','x-amz-meta-recipe':'v1-240-q85'},now:new Date('2026-10-17T03:00:00Z')});
  assert.equal(signed.url,'https://'+'a'.repeat(32)+'.r2.cloudflarestorage.com/bucket/covers/variants/v1/test.webp');
  assert.equal(signed.options.redirect,'manual');
  assert.match(signed.options.headers.authorization,/SignedHeaders=host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-recipe/);
  assert.equal(signed.options.headers['if-none-match'],'*');assert.ok(!signed.url.includes('secret'));
});
