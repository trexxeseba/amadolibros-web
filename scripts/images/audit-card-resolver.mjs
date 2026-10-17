import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { findPreviewCover } from '../../functions/_shared/preview-cover.js';
import { readyCardVariantSource, PRODUCTION_IMAGE_BUCKET, CARD_RECIPES } from '../../functions/_shared/card-variant-delivery.js';
import { prepareCoverIndex, COVER_INDEX_METADATA } from '../../functions/_shared/cover-public-index.js';
import { prepareCardReadiness } from './prepare-card-readiness.mjs';
import { validateCardPlan } from './build-permanent-variants.mjs';

// Uses the real runtime resolver and public-index format. This is an offline
// projection, never R2 writes. Remote verification evidence is supplied by the
// read-only second pass; a dry selection check is explicitly labelled below.
export async function auditCardResolver({manifest,catalog,plan,verified=null}) {
  validateCardPlan(plan);
  if(catalog.items.length!==2790) throw new Error('unexpected-catalog-scope');
  const masters=new Set(plan.masters.map(m=>m.file)), entries={};
  for(const item of catalog.items) entries[item.id+':0']=manifest.entries[item.id+':0'];
  const selected={schema_version:1,entries}, objects=new Map();
  const bucket={
    async put(key,bytes){objects.set(key,typeof bytes==='string'?bytes:new TextDecoder().decode(bytes));return {};},
    async head(key){
      if(key==='covers/v1/manifest.json') return {customMetadata:{[COVER_INDEX_METADATA]:root.hash}};
      const match=/^covers\/variants\/v1\/([a-f0-9]{64})\/(v1-(240|360|480)-q85)\.webp$/.exec(key);
      if(!match||!verified)return null;
      const row=verified[match[1]+'/'+match[2]];
      return row?{size:row.bytes,httpMetadata:{contentType:'image/webp'},
        customMetadata:{master_sha256:match[1],recipe:match[2],sha256:row.sha256}}:null;
    },
    async get(key){const text=objects.get(key);return text?{size:Buffer.byteLength(text),text:async()=>text}:null;}
  };
  const root=await prepareCoverIndex(bucket,selected);
  const context={request:new Request('https://www.amadolibros.com/catalogo'),env:{APP_ENV:'production',
    COVER_R2:bucket,COVER_R2_BUCKET_NAME:PRODUCTION_IMAGE_BUCKET,IMAGE_VARIANTS_READ_ENABLED:'true'},data:{}};
  const resolved=await Promise.all(catalog.items.map(item=>findPreviewCover(context,item.id,0,item.pictures[0])));
  const pairs=new Set();let matched=0;
  for(let i=0;i<resolved.length;i++) {
    const cover=resolved[i];
    if(!cover||!masters.has(cover.sha256+'.'+cover.extension))continue;
    matched++;
    for(const recipe of CARD_RECIPES) {
      const pair=cover.sha256+'/'+recipe;
      if(verified&&!verified[pair])throw new Error('verified-variant-missing');
      pairs.add(pair);
    }
  }
  if(matched!==2790||pairs.size!==8364||context.data.coverIndex?.mode!=='public-index')throw new Error('runtime-resolver-audit-failed');
  if (verified) {
    const readiness = prepareCardReadiness({manifest,catalog,plan,verified});
    objects.set(readiness.key, readiness.text);
    context.env.CARD_VARIANTS_INDEX_SHA256 = readiness.digest;
    context.request = new Request('https://www.amadolibros.com/catalogo?_card_variants=1');
  }
  const ready=verified?(await Promise.all(catalog.items.map(async (item,i)=>{
    const isolated={...context,data:context.data,env:{...context.env,CARD_VARIANTS_CANARY_IDS:item.id}};
    const cover=resolved[i];
    return readyCardVariantSource(isolated,item,cover ? `/preview-cover/${item.id}/0/${cover.sha256}.${cover.extension}` : null);
  }))).filter(Boolean).length:null;
  context.env.IMAGE_VARIANTS_READ_ENABLED='false';
  if((await Promise.all(catalog.items.map(async (item,i)=>{
    const isolated={...context,data:context.data,env:{...context.env,CARD_VARIANTS_CANARY_IDS:item.id}};
    const cover=resolved[i];
    return readyCardVariantSource(isolated,item,cover ? `/preview-cover/${item.id}/0/${cover.sha256}.${cover.extension}` : null);
  }))).some(Boolean))throw new Error('disabled-mode-emitted-variant');
  return {bucket:PRODUCTION_IMAGE_BUCKET,resolver_matched:matched,card_recipe_pairs:matched*3,
    unique_variants:pairs.size,index:context.data.coverIndex.mode,
    remotely_verified:Boolean(verified),canary_ready_cards:ready,production_writes:0};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const [manifest,catalog,plan]=await Promise.all(process.argv.slice(2,5).map(async path=>JSON.parse(await readFile(path,'utf8'))));
  console.log(JSON.stringify(await auditCardResolver({manifest,catalog,plan})));
}
