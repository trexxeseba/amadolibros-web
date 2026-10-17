// Direct S3 transport for the existing offline encoder. No Worker deployment.
import { createHash, createHmac, createCipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildPermanentVariants, validateCardPlan, CARD_RECIPES } from './build-permanent-variants.mjs';
import { IMAGE_VARIANTS, variantObjectKey } from '../../shared/image-variants.js';

export const PLAN_SHA = 'd1e7fe6ef981169bfbe2ea3ab4182b058065ddd4770e1d15ceceaf512696d78c';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hmac = (key, data) => createHmac('sha256',key).update(data).digest();
const MAX_BYTES = 8 * 1024 * 1024;

export function signedS3Request({ account, accessKey, secretKey, bucket, key, method, body, headers = {}, now = new Date() }) {
  if (!/^[a-f0-9]{32}$/.test(account) || !/^[a-f0-9]{32}$/.test(accessKey)) throw new Error('invalid-s3-config');
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g,''), day = date.slice(0,8);
  const host = `${account}.r2.cloudflarestorage.com`;
  const path = '/' + bucket + '/' + key.split('/').map(encodeURIComponent).join('/');
  const payloadHash = sha(body || Buffer.alloc(0));
  const all = { host, 'x-amz-content-sha256':payloadHash, 'x-amz-date':date, ...headers };
  const names = Object.keys(all).sort(), signedHeaders = names.join(';');
  const canonicalHeaders = names.map(k=>k+':'+String(all[k]).trim().replace(/\s+/g,' ')+'\n').join('');
  const canonical = [method,path,'',canonicalHeaders,signedHeaders,payloadHash].join('\n');
  const scope = `${day}/auto/s3/aws4_request`;
  const signingKey = hmac(hmac(hmac(hmac('AWS4'+secretKey,day),'auto'),'s3'),'aws4_request');
  const signature = hmac(signingKey,['AWS4-HMAC-SHA256',date,scope,sha(canonical)].join('\n')).toString('hex');
  all.authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url:'https://'+host+path, options:{method,headers:all,body,redirect:'manual',signal:AbortSignal.timeout(60000)} };
}

async function bounded(response) {
  if (Number(response.headers.get('content-length')) > MAX_BYTES) throw new Error('object-too-large');
  const chunks=[]; let length=0;
  for await (const chunk of response.body) {
    length+=chunk.length;
    if(length>MAX_BYTES) throw new Error('object-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function runCardStages({plan, s3, sharp, checkpoint = async()=>{}, report = ()=>{}, pilotCount=10, approvedDigest=PLAN_SHA}) {
  const masters=validateCardPlan(plan);
  if(plan.masters_sha256!==approvedDigest) throw new Error('unapproved-plan');
  const allowed=new Map(masters.map(master=>[master.file.slice(0,64),master]));
  const state={schema:'card-stage-progress-v1',plan_sha256:PLAN_SHA,stage:'pilot',completed:{},
    pilot_passed:false,created:0,existing:0,verified:0,bytes_uploaded:0,source_downloads:0,
    encode_ms:0,failures:[],started_at:new Date().toISOString()};
  let activeHashes=new Set(masters.slice(0,pilotCount).map(m=>m.file.slice(0,64)));
  const sources=new Map();
  async function inspect(response,hash,recipe,expectedDigest=null) {
    if(response.status!==200) throw new Error(`verify-http-${response.status}`);
    const headers=response.headers, digest=headers.get('x-amz-meta-sha256');
    if(headers.get('content-type')!=='image/webp' || headers.get('x-amz-meta-master_sha256')!==hash ||
       headers.get('x-amz-meta-recipe')!==recipe.id || !/^[a-f0-9]{64}$/.test(digest||'') ||
       expectedDigest && digest!==expectedDigest) throw new Error('variant-metadata-mismatch');
    const bytes=await bounded(response), metadata=await sharp(bytes,{limitInputPixels:40000000}).metadata();
    if(metadata.format!=='webp' || sha(bytes)!==digest ||
       metadata.width!==Number(headers.get('x-amz-meta-width')) || metadata.height!==Number(headers.get('x-amz-meta-height')))
      throw new Error('variant-content-mismatch');
    const source=sources.get(hash)?.metadata;
    // Existing variants carry source dimensions, avoiding repeat original HEADs/GETs.
    const sourceWidth=source?.width || Number(headers.get('x-amz-meta-source_width'));
    const sourceHeight=source?.height || Number(headers.get('x-amz-meta-source_height'));
    if(!Number.isSafeInteger(sourceWidth)||!Number.isSafeInteger(sourceHeight)||sourceWidth<1||sourceHeight<1 ||
       metadata.width!==Math.min(sourceWidth,recipe.width) ||
       Math.abs(metadata.height-Math.round(sourceHeight*metadata.width/sourceWidth))>1)
      throw new Error('variant-dimensions-mismatch');
    state.completed[hash+'/'+recipe.id]={sha256:digest,bytes:bytes.length,width:metadata.width,height:metadata.height};
    state.verified++; await checkpoint(state);
  }
  const fetchFn=async(url,options)=>{
    const parts=url.pathname.slice('/image-variants/'.length).split('/');
    if(parts[0]==='master') {
      const hash=parts[1].slice(0,64), master=allowed.get(hash);
      if(options.method || !activeHashes.has(hash)||parts[1]!==master?.file) throw new Error('master-out-of-scope');
      const response=await s3('GET','covers/v1/objects/'+master.file);
      if(response.status!==200) throw new Error('master-http-'+response.status);
      const bytes=await bounded(response);
      if(sha(bytes)!==hash || bytes.length!==master.size) throw new Error('master-integrity-mismatch');
      const metadata=await sharp(bytes,{limitInputPixels:40000000,failOn:'warning'}).metadata();
      sources.set(hash,{metadata}); state.source_downloads++;
      return new Response(bytes);
    }
    const [hash,id]=parts, recipe=IMAGE_VARIANTS.find(r=>r.id===id);
    if(parts.length!==2||!activeHashes.has(hash)||!CARD_RECIPES.includes(id)) throw new Error('variant-out-of-scope');
    const key=variantObjectKey(hash,id);
    if(options.method==='HEAD') {
      // Check the actual stored bytes and metadata, never a public fallback route.
      const response=await s3('GET',key);
      if(response.status===404) {await response.body?.cancel();return new Response(null,{status:404});}
      await inspect(response,hash,recipe);
      state.existing++; return new Response(null,{status:200});
    }
    if(options.method!=='PUT') throw new Error('method-out-of-scope');
    const bytes=Buffer.from(options.body), metadata=await sharp(bytes).metadata(), source=sources.get(hash)?.metadata;
    if(!source||metadata.format!=='webp'||metadata.width!==Math.min(source.width,recipe.width)||
        Math.abs(metadata.height-Math.round(source.height*metadata.width/source.width))>1) throw new Error('invalid-encoded-variant');
    const digest=sha(bytes), headers={'content-type':'image/webp','cache-control':'public, max-age=31536000, immutable',
      'if-none-match':'*','x-amz-meta-master_sha256':hash,'x-amz-meta-recipe':id,'x-amz-meta-sha256':digest,
      'x-amz-meta-width':String(metadata.width),'x-amz-meta-height':String(metadata.height),
      'x-amz-meta-source_width':String(source.width),'x-amz-meta-source_height':String(source.height)};
    const stored=await s3('PUT',key,bytes,headers);
    if(![200,201,412].includes(stored.status)) throw new Error('upload-http-'+stored.status);
    await stored.body?.cancel();
    if(stored.status!==412) {state.created++;state.bytes_uploaded+=bytes.length;}
    else state.existing++;
    await inspect(await s3('GET',key),hash,recipe,stored.status===412?null:digest);
    return Response.json({status:stored.status===412?'existing':'created'});
  };
  const measuredSharp=(...args)=>{
    const image=sharp(...args), original=image.toBuffer.bind(image);
    image.toBuffer=async(...params)=>{const start=performance.now();try{return await original(...params);}finally{state.encode_ms+=performance.now()-start;}};
    return image;
  };
  async function stage(start,count) {
    const result=await buildPermanentVariants({baseUrl:'https://offline.invalid',token:'offline-adapter',cardPlan:plan,
      cardStart:start,cardCount:count,stopOnFailure:true,sharp:measuredSharp,fetchFn});
    // Only aggregate failure reasons leave the runner; detailed hashes stay encrypted.
    state.failures.push(...result.failures);
    if(state.failures.length) {await checkpoint(state);throw new Error('generation-stage-failed');}
    for(const master of masters.slice(start,start+count)) {
      const hash=master.file.slice(0,64);
      if(!CARD_RECIPES.every(id=>state.completed[hash+'/'+id])) throw new Error('stage-incomplete');
    }
  }
  try {
    await stage(0,pilotCount);
    state.pilot_passed=true;state.stage='pilot-passed';await checkpoint(state);
    report({stage:state.stage,verified_variants:pilotCount*3,created:state.created,errors:0});
    activeHashes=new Set(masters.slice(pilotCount).map(m=>m.file.slice(0,64)));
    sources.clear();state.stage='remaining';
    await stage(pilotCount,masters.length-pilotCount);
    state.stage='completed';state.finished_at=new Date().toISOString();await checkpoint(state);
    return state;
  } catch(error) {
    state.stage='stopped';state.stop_reason=error.message;await checkpoint(state);throw error;
  }
}

async function main() {
  const {default:sharp}=await import('sharp');
  const plan=JSON.parse(await readFile(process.env.IMAGE_VARIANT_CARD_PLAN,'utf8'));
  validateCardPlan(plan);
  if(plan.masters_sha256!==PLAN_SHA || process.env.IMAGE_VARIANT_WRITE_APPROVAL!==PLAN_SHA) throw new Error('unapproved-plan');
  const token=process.env.CLOUDFLARE_API_TOKEN, account=process.env.CLOUDFLARE_ACCOUNT_ID;
  if(!token||!/^[a-f0-9]{32}$/.test(account||'')) throw new Error('existing-secrets-unavailable');
  // Obtain the existing account token identifier solely for S3 authentication.
  // No name lookup, credential creation, policy lookup or credential output.
  const verification=await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/tokens/verify`,{
    headers:{authorization:'Bearer '+token,'user-agent':'amado-card-generation/1.0'},redirect:'manual',signal:AbortSignal.timeout(30000)});
  if(verification.status!==200) throw new Error('existing-token-authentication-failed');
  const accessKey=(await verification.json()).result?.id, secretKey=sha(token);
  const counters={GET:0,PUT:0,bytes_downloaded:0,bytes_uploaded:0,statuses:{}};
  const started=performance.now(), cpuStarted=process.cpuUsage();
  let savedState=null,lastLog=0;
  async function checkpoint(state) {
    savedState=state;
    // Durable journal contains private hashes: encrypt before artifact upload.
    const key=createHash('sha256').update('amado-card-journal-v1\0'+token).digest(), iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',key,iv);
    const encrypted=Buffer.concat([cipher.update(JSON.stringify({state,counters}),'utf8'),cipher.final()]);
    const envelope=JSON.stringify({schema:'encrypted-card-progress-v1',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
    const path=process.env.CARD_PROGRESS_PATH;
    await writeFile(path+'.tmp',envelope,{mode:0o600});await rename(path+'.tmp',path);
    if(Date.now()-lastLog>30000){lastLog=Date.now();console.log(JSON.stringify({stage:state.stage,created:state.created,verified:Object.keys(state.completed).length,existing:state.existing,errors:state.failures.length}));}
  }
  const s3=async(method,key,body,headers)=>{
    // No DELETE, listing, arbitrary bucket, original PUT or progress PUT possible.
    if(!['GET','PUT'].includes(method)||method==='PUT'&&!/^covers\/variants\/v1\/[a-f0-9]{64}\/v1-(240|360|480)-q85\.webp$/.test(key)) throw new Error('s3-operation-out-of-scope');
    const signed=signedS3Request({account,accessKey,secretKey,bucket:plan.bucket,key,method,body,headers});
    counters[method]++;if(body)counters.bytes_uploaded+=body.length;
    const response=await fetch(signed.url,signed.options);
    counters.statuses[response.status]=(counters.statuses[response.status]||0)+1;
    const size=Number(response.headers.get('content-length'));if(size>0)counters.bytes_downloaded+=size;
    return response;
  };
  let failure;
  try {await runCardStages({plan,s3,sharp,checkpoint,report:value=>console.log(JSON.stringify(value))});}
  catch(error){failure=error;}
  const cpu=process.cpuUsage(cpuStarted);
  const summary={stage:savedState?.stage||'not-started',pilot_passed:savedState?.pilot_passed||false,
    expected:8364,verified:Object.keys(savedState?.completed||{}).length,created:savedState?.created||0,
    existing:savedState?.existing||0,errors:savedState?.failures.length||0,stop_reason:failure?.message,
    bytes_stored:savedState?.bytes_uploaded||0,counters,elapsed_ms:Math.round(performance.now()-started),
    encode_ms:Math.round(savedState?.encode_ms||0),cpu_ms:Math.round((cpu.user+cpu.system)/1000),
    error_reasons:[...new Set(savedState?.failures.map(row=>row.reason)||[])],
    web_read_activated:false,deployments:0};
  await writeFile(process.env.CARD_SUMMARY_PATH,JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
  if(failure)process.exitCode=1;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{
  console.error(JSON.stringify({stage:'blocked-before-generation',error:/^[a-z0-9-]+$/.test(error.message)?error.message:'unexpected-local-error'}));process.exitCode=1;
});
