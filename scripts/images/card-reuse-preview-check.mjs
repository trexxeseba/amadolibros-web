import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {normalizeSourceUrl} from '../../functions/_shared/preview-cover.js';
import {CARD_RECIPES} from '../../functions/_shared/card-variant-delivery.js';
import {CARD_REUSE_CANDIDATES as candidates} from './card-reuse-candidates.js';
const base=process.env.INCIDENT_URL,token=process.env.INCIDENT_TOKEN,head=process.env.INCIDENT_BUILD_SHA;
const out='artifacts/card-reuse';await mkdir(out,{recursive:true});
const hash=b=>createHash('sha256').update(b).digest('hex');
const report={head,started_at:new Date().toISOString(),production_writes:0,new_images:0,inventory_lists:0,original_heads:0,images:[],checks:[],failures:[],deferred:[],catalog_visibility:[]};
let batch=[];
const request=(path,extra={})=>{assert.ok(!path.includes('/cdn-cgi/image/'));return fetch(new URL(path,base),{redirect:'manual',headers:{authorization:'Bearer '+token,'x-reuse-index':'1','x-canary-ids':batch.join(','),...extra},signal:AbortSignal.timeout(30000)});};
async function check(name,fn){try{const detail=await fn();report.checks.push({name,pass:true,...detail});}catch(e){report.checks.push({name,pass:false});report.failures.push({name,error:e.message});}}
try{
 let ready=false;for(let i=0;i<20&&!ready;i++){const r=await request('/ready');ready=r.ok&&(await r.json()).head===head;if(!ready)await new Promise(r=>setTimeout(r,3000));}assert.ok(ready,'Preview unavailable');
 const response=await request('/reuse-readiness');assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer()),digest=hash(bytes),index=JSON.parse(bytes);assert.equal(digest,response.headers.get('x-readiness-sha256'));assert.equal(Object.keys(index.cards).length,2819);assert.equal(index.recipes.length,3);
 await writeFile(out+'/readiness-'+digest+'.json',bytes);
 const catalog=await(await fetch('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json')).json();
 report.index={digest,bytes:bytes.length,cards:2819,added:29,key:`covers/card-readiness/v1/${digest}.json`,published:false};report.catalog_updated_at=catalog.updated_at;
 for(let offset=0;offset<candidates.length;offset+=10){
  const group=candidates.slice(offset,offset+10);batch=group.map(c=>c.id);
  for(const row of group){
   const item=catalog.items.find(i=>i.id===row.id),path=`/preview-cover/${row.id}/0/${row.sha256}.${row.extension}`;
   const active=item?.status==='active'&&Number(item.available_quantity)>0;
   if(!active)report.deferred.push({id:row.id,reason:'not-in-current-active-stock-catalog'});
   await check('current-source-and-selector:'+row.id,async()=>{const r=await request('/reuse-select?id='+row.id+'&_card_variants=1',{'x-primary-source':row.source_url,...(!active?{'x-candidate-status':'paused'}:{})});assert.equal(r.status,200);const selected=await r.json();if(!active){assert.equal(selected.full,null);assert.equal(selected.compact,null);return {deferred:true,emitted:false};}assert.equal(normalizeSourceUrl(item.pictures[0]),row.source_url);assert.equal(selected.index,digest);assert.equal(selected.current_hash,row.sha256);for(const f of ['full','compact'])assert.equal(new URL(selected[f]).pathname,path);});
   const decoded=[];
   for(const recipe of CARD_RECIPES)await check('existing-WebP:'+row.id+':'+recipe,async()=>{const r=await request(path+'?variant='+recipe);assert.equal(r.status,200);assert.equal(r.headers.get('x-cover-source'),'r2-variant');assert.equal(r.headers.get('x-cover-variant'),recipe);assert.equal(r.headers.get('x-cover-bucket'),'amadolibros-images-production');assert.equal(r.headers.get('content-type'),'image/webp');const b=Buffer.from(await r.arrayBuffer()),m=await sharp(b).metadata();assert.equal(hash(b),r.headers.get('etag')?.replaceAll('"',''));assert.equal(b.length,Number(r.headers.get('content-length')));assert.equal(m.format,'webp');assert.ok(m.width>0&&m.width<=Number(recipe.split('-')[1]));assert.ok(m.height>0);const data={id:row.id,recipe,bytes:b.length,width:m.width,height:m.height,sha256:hash(b),cache:r.headers.get('x-cover-cache')};decoded.push(data);report.images.push(data);});
   await check('aspect-and-no-upscale:'+row.id,async()=>{assert.equal(decoded.length,3);const largest=decoded[2];for(const d of decoded){assert.equal(d.width,Math.min(Number(d.recipe.split('-')[1]),largest.width));assert.ok(Math.abs(d.height-largest.height*d.width/largest.width)<=2);}});
   if(active)await check('catalog-emission:'+row.id,async()=>{const r=await request('/catalogo?'+new URLSearchParams({q:item.title,_card_variants:'1'}));assert.equal(r.status,200);const html=await r.text(),tag=(html.match(/<img\b[^>]*>/g)||[]).find(t=>t.includes('/'+row.id+'/0/'+row.sha256));if(tag)for(const recipe of CARD_RECIPES)assert.ok(tag.includes('variant='+recipe));const visibility={id:row.id,visible_in_title_search:!!tag};report.catalog_visibility.push(visibility);return visibility;});
  }
 }
 const first=candidates[0];batch=candidates.slice(0,10).map(c=>c.id);
 await check('disabled-emission',async()=>{const r=await request('/reuse-select?id='+first.id+'&_card_variants=1&_canary_off=1',{'x-primary-source':first.source_url});const s=await r.json();assert.equal(s.full,null);assert.equal(s.compact,null);});
 await check('changed-source-rejected',async()=>{const r=await request('/reuse-select?id='+first.id+'&_card_variants=1',{'x-primary-source':'https://http2.mlstatic.com/CHANGED-O.jpg'});const s=await r.json();assert.equal(s.full,null);assert.equal(s.compact,null);});
 await check('missing-explicit-marker',async()=>{const r=await request('/reuse-select?id='+first.id,{'x-primary-source':first.source_url});const s=await r.json();assert.equal(s.full,null);assert.equal(s.compact,null);});
}catch(e){report.failures.push({name:'setup',error:e.message});}
report.finished_at=new Date().toISOString();report.passed=report.checks.filter(c=>c.pass).length;report.image_gets=report.images.length;
await writeFile(out+'/reuse-report.json',JSON.stringify(report,null,2));console.log(JSON.stringify({index:report.index,passed:report.passed,failures:report.failures,deferred:report.deferred,verified_images:report.images.length,visible_cards:report.catalog_visibility.filter(x=>x.visible_in_title_search).length,production_writes:0,new_images:0}));if(report.failures.length)process.exitCode=1;
