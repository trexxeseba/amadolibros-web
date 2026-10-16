import fs from 'node:fs/promises';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {isIP} from 'node:net';
const base=process.env.AMADO_PUBLISHER_ORIGIN||'https://amadolibros-sync.undiaes.workers.dev';
const url=new URL(base);if(url.origin!=='https://amadolibros-sync.undiaes.workers.dev')throw Error('Unsupported publisher origin');
const secret=process.env.SYNC_SECRET;if(!secret)throw Error('SYNC_SECRET is not configured');
const action=process.env.PUBLISHER_ACTION||'status',runId=process.env.PUBLISHER_RUN_ID||undefined;
const allowed=new Set(['status','tick','pause','approve','import','refresh','clone_preflight_catalog']);if(!allowed.has(action))throw Error('Unsupported action');
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
function summary(body){console.log(JSON.stringify({id:body.id,state:body.state,counts:body.counts,policy_hash:body.policy_hash,approved:body.approved,indexed:body.index?.seen,index_complete:body.index?.done,daily_cap:body.daily_cap}));}
async function importFeed(input){
 // PUBLISHER_NEW_RUN=true creates a fresh run (new policy, new approval) and
 // leaves the existing run exactly as it is instead of attaching the feed to it.
 const forceNewRun=process.env.PUBLISHER_NEW_RUN==='true';
 const previous=forceNewRun?{}:runId?{id:runId}:await command('status');
 const targetRun=previous.id,feedId=crypto.randomUUID(),newRun=targetRun||crypto.randomUUID();
 if(!Array.isArray(input.rows)||!input.rows.length)throw Error('Empty supplier feed');
 await command('begin_feed',{feed_id:feedId,source_date:input.source_date,expected_rows:input.rows.length});
 for(let i=0;i<input.rows.length;i+=200)await command('import_feed',{feed_id:feedId,rows:input.rows.slice(i,i+200)});
 await command('commit_feed',{feed_id:feedId});
 const result=targetRun?await attachWhenFree(targetRun,feedId):await command('create_run',{run_id:newRun,feed_id:feedId,policy:input.policy,daily_cap:input.daily_cap??10000,preflight_limit:10});summary(result);
}
async function refreshFeed(){
 const rawUrl=process.env.SUPPLIER_FEED_URL;
 if(!rawUrl){console.log(JSON.stringify({state:'supplier_source_not_configured'}));return;}
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
  console.log(parsed.stdout.trim());await importFeed(JSON.parse(await fs.readFile(outputFile,'utf8')));
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
if(action==='import'){
 const file=process.env.PUBLISHER_FEED_FILE;if(!file)throw Error('PUBLISHER_FEED_FILE is required');
 await importFeed(JSON.parse(await fs.readFile(file,'utf8')));
}else if(action==='refresh'){
 await refreshFeed();
}else if(action==='approve'){
 const hash=process.env.PUBLISHER_POLICY_HASH;if(!runId||!/^[a-f0-9]{64}$/.test(hash??''))throw Error('Run ID and reviewed policy hash are required');summary(await command('approve',{run_id:runId,policy_hash:hash}));
}else if(action==='clone_preflight_catalog'){
 // Catalog preflight over the review ISBNs of an existing run: new unapproved run, /items/validate only.
 if(!runId)throw Error('Source run ID is required');
 // PUBLISHER_FEED_ID optionally runs the clone over a fresh supplier feed (max 5 ISBN).
 const feedId=process.env.PUBLISHER_FEED_ID||undefined;
 const limit=process.env.PUBLISHER_PREFLIGHT_LIMIT?Number(process.env.PUBLISHER_PREFLIGHT_LIMIT):feedId?5:10;
 const result=await command('clone_preflight_catalog',{source_run_id:runId,limit,...(feedId?{feed_id:feedId}:{})});
 console.log(JSON.stringify({new_run_id:result.new_run_id,source_run_id:result.source_run_id,created:result.created,feed_id:result.feed_id,source_feed_id:result.source_feed_id,policy_hash:result.policy_hash,source_policy_hash:result.source_policy_hash,state:result.state,approved:result.approved,validated:result.validated,review:result.review,pending:result.pending,published:result.published,source_run_intact:result.source_run_intact,last_tick:result.last_tick}));
 for(const job of result.preflight)console.log(JSON.stringify(job));
}else if(action==='tick'){
 const cycles=Math.min(20,Math.max(1,Number(process.env.PUBLISHER_CYCLES)||1));
 for(let i=0;i<cycles;i++){const result=await command('tick',{run_id:runId});summary(result);if(!['preflight','publishing','busy'].includes(result.state))break;}
}else summary(await command(action,{run_id:runId}));
