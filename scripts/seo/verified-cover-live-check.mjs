import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { VERIFIED_COVER_SOURCES } from '../../functions/_shared/verified-cover-sources.js';
import { inspectCoverBytes } from '../../worker-sync/cover-mirror.js';
const base = process.env.QW2_PREVIEW_URL;
if (!base || !/^https:\/\/pr-\d+\.amadolibros-web\.pages\.dev$/.test(base)) throw new Error('Expected isolated PR Preview URL');
const out = 'artifacts/qw2-verified-covers';
await mkdir(out,{recursive:true});
async function image(url) {
  const r=await fetch(url,{signal:AbortSignal.timeout(30000)});
  if(!r.ok) throw new Error(url+' HTTP '+r.status);
  const bytes=new Uint8Array(await r.arrayBuffer());
  return {...inspectCoverBytes(bytes,r.headers.get('content-type')),sha256:createHash('sha256').update(bytes).digest('hex'),source:r.headers.get('x-cover-source'),bytes};
}
const catalogResponse=await fetch('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json');
if(!catalogResponse.ok) throw new Error('Catalog HTTP '+catalogResponse.status);
const catalog=await catalogResponse.json();
const rows=[];
for(const entry of VERIFIED_COVER_SOURCES) {
  const row={id:entry.product_id,original_source:entry.source_url,native_source:entry.replacement_url}; rows.push(row);
  try {
    const item=catalog.items.find(x=>x.id===entry.product_id);
    if(!item || item.status!=='active') throw new Error('Product no longer active');
    const position=[...new Set(item.pictures)].indexOf(entry.source_url);
    if(position<0) throw new Error('Source no longer present in catalog');
    const path='/book-cover/'+entry.product_id+'/'+(position===0?'cover.jpg':'cover-'+(position+1)+'.jpg');
    row.path=path;
    const [production,preview,native]=await Promise.all([image('https://www.amadolibros.com'+path),image(base+path),image(entry.replacement_url)]);
    for(const [name,data] of Object.entries({production,preview,native})) {
      const {bytes,...meta}=data;row[name]=meta;
      await writeFile(out+'/'+entry.product_id+'-'+position+'-'+name+'.'+meta.ext,bytes);
    }
    if(preview.width<500 || preview.height<500) throw new Error('Preview below 500px');
    if(preview.source!=='r2-preview') throw new Error('Preview must serve the real R2 copy');
    if(preview.sha256!==native.sha256) throw new Error('Preview is not the verified native bytes');
    row.short_edge_gain=Math.min(preview.width,preview.height)-Math.min(production.width,production.height);
    row.ok=true;
  } catch(error) {row.ok=false;row.error=error.message;}
}
await writeFile(out+'/report.json',JSON.stringify({generated_at:new Date().toISOString(),preview:base,catalog_updated_at:catalog.updated_at,rows},null,2));
console.log(JSON.stringify(rows));
if(rows.some(x=>!x.ok))process.exitCode=1;
