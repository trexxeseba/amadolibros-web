import {readFile,writeFile} from 'node:fs/promises';
import {createCipheriv,randomBytes,publicEncrypt,constants} from 'node:crypto';
const token=process.env.CLOUDFLARE_ADMIN_API_TOKEN,account=process.env.CLOUDFLARE_ACCOUNT_ID;
const report={checked_at:new Date().toISOString(),mode:process.env.CONTAINMENT_MODE,events:[],rules:[],tests:[]};
const rulesetPhase='http_request_dynamic_redirect';
async function api(path,method='GET',body){
 const response=await fetch('https://api.cloudflare.com/client/v4'+path,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(30000)});
 const data=await response.json();
 report.events.push({path,method,http:response.status,success:data.success,errors:data.errors});
 console.log(JSON.stringify({operation:method,http:response.status,success:data.success}));
 if(!response.ok||!data.success)throw Error('cloudflare-api-rejected');
 return data.result;
}
async function save(){
 const schema='amado-cloudflare-containment-v1',key=randomBytes(32),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(Buffer.from(schema));
 const data=Buffer.concat([cipher.update(JSON.stringify(report),'utf8'),cipher.final()]);
 const publicKey=await readFile('scripts/images/cf-usage-audit-public.pem');
 await writeFile(process.env.CF_USAGE_OUTPUT,JSON.stringify({schema,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),key:publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},key).toString('base64'),data:data.toString('base64')}));
}
try{
 if(!token||!account)throw Error('missing-configured-access');
 const zones=await api('/zones?name=amadolibros.com');
 const zone=zones.find(z=>z.name==='amadolibros.com'&&z.account?.id===account);
 if(!zone)throw Error('account-zone-mismatch');
 const prefix='/zones/'+zone.id;
 const all=await api(prefix+'/rulesets');
 const entry=all.find(r=>r.phase===rulesetPhase&&r.kind==='zone');
 let before=entry?await api(prefix+'/rulesets/'+entry.id):null;
 report.before=before;report.zone_account_matched=true;
 if(process.env.CONTAINMENT_MODE==='apply'){
  if(!before){
   before=await api(prefix+'/rulesets','POST',{name:'Image cost containment redirects',kind:'zone',phase:rulesetPhase,rules:[]});
   report.created_entrypoint=before.id;
  }
  const created=[];
  try{
   for(const root of ['book-cover','preview-cover']){
    const ref='image_cost_containment_'+root.replaceAll('-','_');
    const rule={ref,description:'Temporary cover transformation containment - originals',expression:'(http.host in {"www.amadolibros.com" "amadolibros.com"} and http.request.method in {"GET" "HEAD"} and http.request.uri.path wildcard "/cdn-cgi/image/*/'+root+'/*")',action:'redirect',action_parameters:{from_value:{target_url:{expression:'wildcard_replace(http.request.uri.path, "/cdn-cgi/image/*/'+root+'/*", "https://www.amadolibros.com/'+root+'/${2}")'},status_code:302,preserve_query_string:false}},enabled:false};
    const existing=before.rules?.find(r=>r.ref===ref);
    if(existing){
     if(existing.enabled!==false||existing.expression!==rule.expression||JSON.stringify(existing.action_parameters)!==JSON.stringify(rule.action_parameters))throw Error('existing-containment-review-required');
    }
    const updated=existing?before:await api(prefix+'/rulesets/'+before.id+'/rules','POST',rule);
    const added=updated.rules.find(r=>r.ref===ref);if(!added)throw Error('created-rule-not-returned');
    created.push({id:added.id,rule});report.rules.push({id:added.id,ref,enabled:false});
   }
   for(const added of created){
    await api(prefix+'/rulesets/'+before.id+'/rules/'+added.id,'PATCH',{...added.rule,enabled:true});
    report.rules.find(r=>r.id===added.id).enabled=true;
   }
   const after=await api(prefix+'/rulesets/'+before.id);report.after=after;
   for(const old of before.rules||[]){
    if(created.some(r=>r.id===old.id))continue;
    const kept=after.rules.find(r=>r.id===old.id);
    for(const field of ['expression','action','action_parameters','enabled'])if(JSON.stringify(kept?.[field])!==JSON.stringify(old[field]))throw Error('existing-rule-changed');
   }
   // A bounded pair of real checks, not an image inventory. Never follow a transform redirect automatically.
   const samples=JSON.parse(await readFile('scripts/images/cf-containment-samples.json','utf8'));
   if(process.env.CONTAINMENT_PROPAGATION_MS){
    const ms=Number(process.env.CONTAINMENT_PROPAGATION_MS);
    if(!Number.isFinite(ms)||ms<0||ms>45000)throw Error('invalid-propagation-wait');
    console.log('Waiting for edge configuration propagation');
    await new Promise(resolve=>setTimeout(resolve,ms));
    report.trace=await api('/accounts/'+account+'/request-tracer/trace','POST',{method:'GET',url:'https://www.amadolibros.com'+samples[0]});
   }
   for(const sample of samples){
    const transformed='https://www.amadolibros.com'+sample;
    const expected='https://www.amadolibros.com/'+sample.split('/').slice(4).join('/');
    const response=await fetch(transformed,{redirect:'manual',signal:AbortSignal.timeout(20000)});
    const location=response.headers.get('location');await response.body?.cancel();
    report.tests.push({path:sample,status:response.status,location,expected});
    if(response.status!==302||location!==expected)throw Error('redirect-live-verification-failed');
    const original=await fetch(expected,{redirect:'manual',signal:AbortSignal.timeout(20000)});
    const bytes=new Uint8Array(await original.arrayBuffer());
    report.tests.push({original:expected,status:original.status,type:original.headers.get('content-type'),bytes:bytes.length});
    if(original.status!==200||!original.headers.get('content-type')?.startsWith('image/')||!bytes.length)throw Error('original-live-verification-failed');
   }
   report.success=true;
  }catch(error){
   report.failure=error.message;
   for(const added of created){try{await api(prefix+'/rulesets/'+before.id+'/rules/'+added.id,'PATCH',{...added.rule,enabled:false});report.rules.find(r=>r.id===added.id).enabled=false;}catch{report.rollback_failed=true;}}
   throw error;
  }
 }
 console.log(JSON.stringify({mode:report.mode,success:report.success??true,existing_rules:before?.rules?.length??0}));
}catch(error){report.failure=error.message;process.exitCode=1;console.log(JSON.stringify({failure:error.message}));}finally{await save();}
