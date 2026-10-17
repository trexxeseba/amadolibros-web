import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CARD_RECIPES, validateCardPlan, buildPermanentVariants } from '../build-permanent-variants.mjs';
import { prepareCardPlan } from '../prepare-card-plan.mjs';
import sharp from 'sharp';
import { handleImageVariants } from '../../../worker-sync/image-variants-api.js';

function fixture() {
  const masters = Array.from({length:2788}, (_, i) => ({ file: i.toString(16).padStart(64,'0') + '.jpg', size:100 }));
  return { schema:'active-card-variants-v1', bucket:'amadolibros-images-production',
    baseline:'29c5dce82ce807fdcd58d3c49c21fc64dc2b5cea', recipes:[...CARD_RECIPES], masters,
    masters_sha256:createHash('sha256').update(JSON.stringify(masters)).digest('hex') };
}

test('scoped run checks exactly 8364 variants and never lists masters, reads originals or writes progress', async () => {
  const plan = fixture(), paths = new Set();
  const result = await buildPermanentVariants({baseUrl:'https://test.example', token:'test-only', cardPlan:plan,
    fetchFn:async (url, options) => {
      assert.equal(options.method,'HEAD');
      assert.match(url.pathname,/\/image-variants\/[a-f0-9]{64}\/v1-(240|360|480)-q85$/);
      assert.ok(!paths.has(url.pathname)); paths.add(url.pathname);
      return new Response(null,{status:200});
    }});
  assert.equal(paths.size,8364);
  assert.equal(result.existing,8364); assert.equal(result.sourcesDownloaded,0);
  assert.equal(result.created,0); assert.deepEqual(result.failures,[]);
});

test('rejects scope expansion, duplicate hashes, changed plan and wrong bucket before network', async () => {
  for (const change of [p=>p.masters.pop(),p=>p.masters.push(p.masters[0]),
    p=>p.masters[1]=p.masters[0],p=>p.recipes.push('v1-1024-q88'),
    p=>p.bucket='amadolibros-images-preview',p=>p.masters[0].size=101]) {
    const plan=fixture(); change(plan);
    await assert.rejects(buildPermanentVariants({baseUrl:'https://test.example',token:'test-only',cardPlan:plan,
      fetchFn:()=>{throw new Error('network-must-not-run');}}), /invalid-card|digest-mismatch/);
  }
});

test('scoped generation encodes only the missing three recipes, reuses existing objects and resumes without duplicates', async () => {
  const bytes=await sharp({create:{width:600,height:900,channels:3,background:'#ccaabb'}}).png().toBuffer();
  const hash=createHash('sha256').update(bytes).digest('hex'), plan=fixture();
  plan.masters[0]={file:hash+'.png',size:bytes.length};
  plan.masters_sha256=createHash('sha256').update(JSON.stringify(plan.masters)).digest('hex');
  const objects=new Map(), writes=[];
  const bucket={
    head:async key=>objects.get(key)||null,
    get:async key=>key==='covers/v1/objects/'+hash+'.png'?{body:bytes,size:bytes.length}:null,
    put:async (key,body,options)=>{
      assert.ok(!objects.has(key)); assert.equal(options.onlyIf.etagDoesNotMatch,'*');
      const metadata=await sharp(body).metadata(); assert.equal(metadata.format,'webp');
      assert.ok([240,360,480].includes(metadata.width));
      objects.set(key,{size:body.length,...options}); writes.push(key); return {};
    }};
  const fetchFn=async(url,options)=>{
    if (!url.pathname.includes(hash)) { assert.equal(options.method,'HEAD'); return new Response(null,{status:200}); }
    return handleImageVariants(new Request(url,options),{COVER_R2:bucket,IMAGE_VARIANTS_WRITE_ENABLED:'true'});
  };
  const run=()=>buildPermanentVariants({baseUrl:'https://test.example',token:'test-only',cardPlan:plan,sharp,fetchFn});
  const first=await run(); assert.deepEqual(first.failures,[]); assert.equal(first.created,3);
  assert.equal(first.sourcesDownloaded,1); assert.equal(writes.length,3);
  const second=await run(); assert.equal(second.created,0); assert.equal(second.sourcesDownloaded,0);
  assert.equal(writes.length,3);
});

test('frozen inputs select only position zero, deduplicate and exclude inactive/history/gallery', () => {
  const plan=fixture(), entries={}, items=[], ids=[];
  for(let i=0;i<2790;i++) {
    const id='MLU'+i, master=plan.masters[i%2788]; ids.push(id);
    const current={object_key:'covers/v1/objects/'+master.file,sha256:master.file.slice(0,64),bytes:master.size,source_url:'https://http2.mlstatic.com/'+i+'.jpg'};
    entries[id+':0']={current}; entries[id+':1']={current:{object_key:'gallery-invalid'}};
    items.push({id,status:'active',available_quantity:1,pictures:[current.source_url]});
  }
  while(ids.length<8225) ids.push('MLU'+(ids.length+10000));
  items.push({id:ids.at(-1),status:'paused',available_quantity:1});
  entries['history:0']={current:{object_key:'historical-invalid'}};
  const manifest={updated_at:'2026-10-17T03:10:32.644Z',entries};
  const catalog={updated_at:'2026-10-17T03:10:21.984Z',items};
  const selected=prepareCardPlan(manifest,catalog,ids);
  assert.equal(validateCardPlan(selected).length,2788);
  assert.deepEqual(selected.masters,plan.masters);
  catalog.updated_at='later';
  assert.throws(()=>prepareCardPlan(manifest,catalog,ids),/snapshot-mismatch/);
});
