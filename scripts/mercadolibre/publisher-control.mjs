import fs from 'node:fs/promises';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {isIP} from 'node:net';
const base=process.env.AMADO_PUBLISHER_ORIGIN||'https://amadolibros-sync.undiaes.workers.dev';
const url=new URL(base);if(url.origin!=='https://amadolibros-sync.undiaes.workers.dev')throw Error('Unsupported publisher origin');
const secret=process.env.SYNC_SECRET;if(!secret)throw Error('SYNC_SECRET is not configured');
const action=process.env.PUBLISHER_ACTION||'status',runId=process.env.PUBLISHER_RUN_ID||undefined;
// Precio competitivo para el lote clonado. Vacío = hereda la política de origen.
function competitiveArgs(){
 const out={};
 const flag=process.env.PUBLISHER_COMPETITIVE;
 if(flag==='true'||flag==='false')out.competitive=flag==='true';
 const floor=process.env.PUBLISHER_COMPETITIVE_FLOOR_MARGIN;
 if(floor)out.competitive_floor_margin=Number(floor);
 const minC=process.env.PUBLISHER_MINIMUM_CONTRIBUTION;
 if(minC)out.minimum_contribution_uyu=Number(minC);
 return out;
}
const allowed=new Set(['status','tick','pause','approve','import','refresh','clone_preflight_catalog','shipping_diagnostic','shipping_probe','create_run_from_source','audit_availability_terms','queue_kick']);if(!allowed.has(action))throw Error('Unsupported action');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function command(action,args={}){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),90000);
 try{
  const response=await fetch(new URL('/publisher/command',url),{method:'POST',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({action,args}),redirect:'manual',signal:controller.signal});
  const body=await response.json();if(!response.ok){const error=Error(`Publisher ${action}: ${body.error||response.status}`);error.code=body.error;throw error;}return body;
 }finally{clearTimeout(timer);}
}
// The Worker tick holds the run lease for up to ~30 s of every minute. A busy
// run must not cost the daily snapshot: wait for the lease instead of failing.
async function attachWhenFree(runId,feedId,{attempts=24,waitMs=15000}={}){
 for(let attempt=1;;attempt++){
  try{return await command('attach_feed',{run_id:runId,feed_id:feedId});}
  catch(error){if(error.code!=='run_busy'||attempt>=attempts)throw error;console.log(JSON.stringify({state:'run_busy',attempt,retry_in_ms:waitMs}));await sleep(waitMs);}
 }
}
function summary(body){console.log(JSON.stringify({id:body.id,state:body.state,counts:body.counts,policy_hash:body.policy_hash,approved:body.approved,indexed:body.index?.seen,index_complete:body.index?.done,daily_cap:body.daily_cap,target_published:body.target_published,target_remaining:body.target_remaining,queued:body.queued}));}
async function importFeed(input){
 const refreshOnly=process.env.PUBLISHER_REFRESH_ONLY==='true';
 // PUBLISHER_NEW_RUN=true creates a fresh run (new policy, new approval) and
 // leaves the existing run exactly as it is instead of attaching the feed to it.
 const forceNewRun=process.env.PUBLISHER_NEW_RUN==='true';
 const previous=forceNewRun?{}:runId?{id:runId}:await command('status');
 const targetRun=previous.id,feedId=crypto.randomUUID(),newRun=targetRun||crypto.randomUUID();
 if(!Array.isArray(input.rows)||!input.rows.length)throw Error('Empty supplier feed');
 await command('begin_feed',{feed_id:feedId,source_date:input.source_date,expected_rows:input.rows.length});
 for(let i=0;i<input.rows.length;i+=200)await command('import_feed',{feed_id:feedId,rows:input.rows.slice(i,i+200)});
 await command('commit_feed',{feed_id:feedId});
 if(refreshOnly){console.log(JSON.stringify({state:'feed_ready',feed_id:feedId,source_date:input.source_date,rows:input.rows.length}));return {feed_id:feedId,source_date:input.source_date,rows:input.rows.length};}
 const result=targetRun?await attachWhenFree(targetRun,feedId):await command('create_run',{run_id:newRun,feed_id:feedId,policy:input.policy,daily_cap:input.daily_cap??10000,preflight_limit:10});summary(result);
}
function sampleSupplierInput(input){
 const requested=Number(process.env.PUBLISHER_SAMPLE_SIZE||0);
 if(!Number.isInteger(requested)||requested<=0||requested>=input.rows.length)return input;
 const seed=String(process.env.PUBLISHER_SAMPLE_SEED||'amado');
 const ranked=input.rows.map(row=>({row,score:createHash('sha256').update(seed+'\0'+row.isbn).digest('hex')}))
  .sort((a,b)=>a.score.localeCompare(b.score)).slice(0,requested).map(x=>x.row);
 console.log(JSON.stringify({state:'sampled_supplier_feed',source_rows:input.rows.length,selected_rows:ranked.length,seed}));
 return {...input,rows:ranked};
}
async function refreshFeed(){
 const rawUrl=process.env.SUPPLIER_FEED_URL;
 if(!rawUrl)throw Error('SUPPLIER_FEED_URL is not configured');
 let source;try{source=new URL(rawUrl);}catch{throw Error('Unsupported supplier source');}const host=source.hostname.replace(/^\[|\]$/g,'');
 if(source.protocol!=='https:'||source.username||source.password||isIP(host)||host==='localhost'||/\.(local|internal)$/.test(host))throw Error('Unsupported supplier source');
 const directory=await mkdtemp(join(tmpdir(),'amado-supplier-'));
 try{
  const headers={};if(process.env.SUPPLIER_FEED_AUTHORIZATION)headers.Authorization=process.env.SUPPLIER_FEED_AUTHORIZATION;
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),60000);let bytes;
  try{const response=await fetch(source,{headers,redirect:'manual',signal:controller.signal});if(!response.ok||!response.body)throw Error();const reader=response.body.getReader(),chunks=[];let size=0;while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>64*1024*1024){await reader.cancel();throw Error();}chunks.push(value);}bytes=Buffer.concat(chunks);}catch{throw Error('Supplier download failed');}finally{clearTimeout(timer);}
  const sourceFile=join(directory,'supplier.xlsx'),outputFile=join(directory,'feed.json');await fs.writeFile(sourceFile,bytes);
  const parsed=spawnSync('python3',['scripts/mercadolibre/prepare-supplier-feed.py',sourceFile,outputFile,'--weight-unit',process.env.SUPPLIER_WEIGHT_UNIT||'kg'],{encoding:'utf8'});
  if(parsed.status!==0)throw Error('Supplier workbook validation failed');
  console.log(parsed.stdout.trim());const input=sampleSupplierInput(JSON.parse(await fs.readFile(outputFile,'utf8')));await importFeed(input);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
if(action==='import'){
 const file=process.env.PUBLISHER_FEED_FILE;if(!file)throw Error('PUBLISHER_FEED_FILE is required');
 await importFeed(JSON.parse(await fs.readFile(file,'utf8')));
}else if(action==='refresh'){
 await refreshFeed();
}else if(action==='approve'){
 const hash=process.env.PUBLISHER_POLICY_HASH;if(!runId||!/^[a-f0-9]{64}$/.test(hash??''))throw Error('Run ID and reviewed policy hash are required');summary(await command('approve',{run_id:runId,policy_hash:hash}));
}else if(action==='create_run_from_source'){
 if(!runId)throw Error('Source run ID is required');
 const feedId=process.env.PUBLISHER_FEED_ID;if(!feedId)throw Error('Fresh feed ID is required');
 const availabilityDays=process.env.PUBLISHER_AVAILABILITY_DAYS?Number(process.env.PUBLISHER_AVAILABILITY_DAYS):undefined;
 const dailyCap=process.env.PUBLISHER_DAILY_CAP?Number(process.env.PUBLISHER_DAILY_CAP):1000;
 const preflightLimit=process.env.PUBLISHER_PREFLIGHT_LIMIT?Number(process.env.PUBLISHER_PREFLIGHT_LIMIT):20;
 const targetPublished=process.env.PUBLISHER_TARGET_PUBLISHED?Number(process.env.PUBLISHER_TARGET_PUBLISHED):undefined;
 const result=await command('create_run_from_source',{...competitiveArgs(),source_run_id:runId,feed_id:feedId,daily_cap:dailyCap,preflight_limit:preflightLimit,...(availabilityDays!==undefined?{availability_days:availabilityDays}:{}),...(targetPublished!==undefined?{target_published:targetPublished}:{})});
 console.log(JSON.stringify({new_run_id:result.new_run_id,source_run_id:result.source_run_id,created:result.created,feed_id:result.feed_id,availability_days:result.availability_days,catalog_listing:result.catalog_listing,policy_hash:result.policy_hash,source_policy_hash:result.source_policy_hash,state:result.state,approved:result.approved,daily_cap:result.daily_cap,target_published:result.target_published,target_remaining:result.target_remaining,source_run_intact:result.source_run_intact,counts:result.counts}));
 const cycles=Math.min(20,Math.max(1,Number(process.env.PUBLISHER_CYCLES)||1));
 for(let i=0;i<cycles;i++){const step=await command('tick',{run_id:result.new_run_id});summary(step);if(!['preflight','busy','backoff'].includes(step.state))break;}
}else if(action==='clone_preflight_catalog'){
 // Catalog preflight over the review ISBNs of an existing run: new unapproved run, /items/validate only.
 if(!runId)throw Error('Source run ID is required');
 // PUBLISHER_FEED_ID optionally runs the clone over a fresh supplier feed (max 5 ISBN).
 const feedId=process.env.PUBLISHER_FEED_ID||undefined;
 const limit=process.env.PUBLISHER_PREFLIGHT_LIMIT?Number(process.env.PUBLISHER_PREFLIGHT_LIMIT):feedId?5:10;
 // PUBLISHER_AVAILABILITY_DAYS optionally overrides availabilityDays in the cloned policy (changes the policy_hash).
 const availabilityDays=process.env.PUBLISHER_AVAILABILITY_DAYS?Number(process.env.PUBLISHER_AVAILABILITY_DAYS):undefined;
 const result=await command('clone_preflight_catalog',{...competitiveArgs(),source_run_id:runId,limit,...(feedId?{feed_id:feedId}:{}),...(availabilityDays!==undefined?{availability_days:availabilityDays}:{})});
 console.log(JSON.stringify({new_run_id:result.new_run_id,source_run_id:result.source_run_id,created:result.created,feed_id:result.feed_id,source_feed_id:result.source_feed_id,availability_days:result.availability_days,policy_hash:result.policy_hash,source_policy_hash:result.source_policy_hash,state:result.state,approved:result.approved,validated:result.validated,review:result.review,pending:result.pending,published:result.published,source_run_intact:result.source_run_intact,last_tick:result.last_tick}));
 for(const job of result.preflight)console.log(JSON.stringify(job));
}else if(action==='audit_availability_terms'){
 if(!runId)throw Error('Run ID is required');
 let offset=0,total=0,ok=0,missing=0,wrong=0;const mismatches=[];
 for(;;){
  const page=await command('audit_availability_terms',{run_id:runId,offset,limit:100});
  total=page.total_published;ok+=page.ok;missing+=page.missing;wrong+=page.wrong;
  for(const row of page.mismatches??[])if(mismatches.length<100)mismatches.push(row);
  if(page.next_offset==null)break;offset=page.next_offset;
 }
 console.log(JSON.stringify({run_id:runId,total_published:total,expected_days:18,ok,missing,wrong,mismatches},null,1));
}else if(action==='shipping_diagnostic'){
 // Read-only: GET lookups of the account's shipping configuration. Never publishes.
 const price=process.env.PUBLISHER_ITEM_PRICE?Number(process.env.PUBLISHER_ITEM_PRICE):undefined;
 const result=await command('shipping_diagnostic',{...(runId?{run_id:runId}:{}),...(process.env.PUBLISHER_ITEM_ID?{item_id:process.env.PUBLISHER_ITEM_ID}:{}),...(price!==undefined?{item_price:price}:{})});
 console.log(JSON.stringify(result,null,1));
}else if(action==='shipping_probe'){
 // Same prepare() as the queue on one ISBN: /items/validate only, never publishes.
 const isbn=process.env.PUBLISHER_ISBN;if(!runId||!isbn)throw Error('Run ID and ISBN are required');
 const result=await command('shipping_probe',{run_id:runId,isbn,...(process.env.PUBLISHER_FEED_ID?{feed_id:process.env.PUBLISHER_FEED_ID}:{})});
 console.log(JSON.stringify(result,null,1));
}else if(action==='tick'){
 const cycles=Math.min(20,Math.max(1,Number(process.env.PUBLISHER_CYCLES)||1));
 for(let i=0;i<cycles;i++){const result=await command('tick',{run_id:runId});summary(result);if(!['preflight','publishing','busy'].includes(result.state))break;}
}else summary(await command(action,{run_id:runId}));
