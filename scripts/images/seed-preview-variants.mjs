import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { buildPermanentVariants } from './build-permanent-variants.mjs';

const base = new URL(process.env.WORKER_SYNC_TRIGGER_URL);
base.pathname='/image-variants/';base.search='';base.hash='';
if(base.protocol!=='https:' || !process.env.SYNC_SECRET)throw new Error('invalid-preview-config');
const html=await readFile('astro-front/dist/index.html','utf8');
const ids=[...new Set([process.env.IMAGE_VARIANT_SAMPLE_PRODUCT_ID,
  ...[...html.matchAll(/\/book-cover\/(MLU\d+)\/cover\.jpg/g)].map(m=>m[1])].filter(id=>/^MLU\d+$/.test(id||'')))].slice(0,16);
for(let offset=0;offset<ids.length;offset+=8){
  const response=await fetch(new URL('seed',base),{method:'POST',redirect:'manual',signal:AbortSignal.timeout(120_000),
    headers:{authorization:`Bearer ${process.env.SYNC_SECRET}`,'content-type':'application/json'},
    body:JSON.stringify({productIds:ids.slice(offset,offset+8)})});
  if(response.status!==200)throw new Error(`preview-seed-http-${response.status}`);
}
const results=[];
for(const productId of ids){
  const result=await buildPermanentVariants({baseUrl:base.href,token:process.env.SYNC_SECRET,sharp,productId,resume:false,limit:20});
  results.push({productId,...result});
  if(result.failures.length)throw new Error('preview-generation-failed');
}
console.log(JSON.stringify({products:ids.length,created:results.reduce((s,r)=>s+r.created,0),results},null,2));
