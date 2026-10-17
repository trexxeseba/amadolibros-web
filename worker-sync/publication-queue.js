import {PublicationError} from './publication-policy.js';

const QUEUE_BINDING='ML_PUBLISH_QUEUE';
const QUEUE_VERSION=1;
const MAX_DELAY_SECONDS=86400;

const clampDelay=value=>Math.max(0,Math.min(MAX_DELAY_SECONDS,Math.ceil(Number(value)||0)));

export function publicationQueueEnabled(env){
 return String(env?.ML_PUBLISH_QUEUE_ENABLED)==='true'&&env?.[QUEUE_BINDING]&&typeof env[QUEUE_BINDING].send==='function';
}

export async function enqueuePublicationWork(env,runId,{delaySeconds=0}={}){
 if(!publicationQueueEnabled(env))return {queued:false,reason:'queue_disabled'};
 if(typeof runId!=='string'||!/^[a-f0-9-]{36}$/.test(runId))throw new PublicationError('invalid_run_id');
 const options=clampDelay(delaySeconds)>0?{delaySeconds:clampDelay(delaySeconds)}:undefined;
 await env[QUEUE_BINDING].send({v:QUEUE_VERSION,run_id:runId},options);
 return {queued:true,delay_seconds:clampDelay(delaySeconds)};
}

export function secondsUntilMontevideoDay(now=Date.now()){
 const shifted=new Date(now-3*3600000),day=shifted.toISOString().slice(0,10);
 const next=Date.parse(day+'T03:00:00Z')+86400000;
 return clampDelay(Math.max(1,(next-now)/1000));
}

function uncertainCount(result){
 return (result?.counts??[]).find(x=>x.state==='uncertain')?.n??0;
}

function retryDelayForResult(result,now){
 if(result?.state==='busy')return 5;
 if(result?.state==='backoff'&&result.resume_at){
  const resume=Date.parse(result.resume_at);
  return Number.isFinite(resume)?clampDelay(Math.max(1,(resume-now)/1000)):60;
 }
 if(result?.state==='daily_cap_reached')return secondsUntilMontevideoDay(now);
 if(result?.state==='complete_with_review'&&uncertainCount(result)>0)return 600;
 return null;
}

export function createPublicationQueueHandler(service,{now=Date.now}={}){
 if(!service||typeof service.tick!=='function')throw new Error('publication service is required');
 return async function handlePublicationQueue(batch,env){
  if(!Array.isArray(batch?.messages))throw new PublicationError('invalid_queue_batch',400);
  for(const message of batch.messages){
   const body=message?.body;
   if(!body||body.v!==QUEUE_VERSION||typeof body.run_id!=='string'||!/^[a-f0-9-]{36}$/.test(body.run_id)){
    message.ack();
    continue;
   }
   try{
    const result=await service.tick(env,body.run_id);
    const delay=retryDelayForResult(result,now());
    if(result?.state==='publishing'){
     await enqueuePublicationWork(env,body.run_id);
    }else if(delay!==null){
     await enqueuePublicationWork(env,body.run_id,{delaySeconds:delay});
    }
    message.ack();
   }catch(error){
    const retryable=error?.status===429||error?.status>=500||error?.code==='lease_lost'||error?.code==='run_busy';
    if(retryable&&typeof message.retry==='function')message.retry({delaySeconds:error?.status===429?60:30});
    else throw error;
   }
  }
 };
}
