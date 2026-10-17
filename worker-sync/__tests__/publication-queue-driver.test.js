import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPublicationQueueHandler,
  enqueuePublicationWork,
  publicationQueueEnabled,
  secondsUntilMontevideoDay,
} from '../publication-queue.js';

const runId='11111111-2222-3333-4444-555555555555';

function message(body={v:1,run_id:runId}){
 const state={acked:0,retried:[]};
 return {
  body,
  ack(){state.acked++;},
  retry(options){state.retried.push(options);},
  state,
 };
}

test('queue binding is opt-in and enqueue is durable before ack',async()=>{
 const disabled={ML_PUBLISH_QUEUE_ENABLED:'false'};
 assert.equal(publicationQueueEnabled(disabled),false);
 assert.deepEqual(await enqueuePublicationWork(disabled,runId),{queued:false,reason:'queue_disabled'});
 const sent=[];
 const env={ML_PUBLISH_QUEUE_ENABLED:'true',ML_PUBLISH_QUEUE:{send:async(body,options)=>sent.push({body,options})}};
 assert.equal(publicationQueueEnabled(env),true);
 assert.deepEqual(await enqueuePublicationWork(env,runId),{queued:true,delay_seconds:0});
 assert.deepEqual(sent,[{body:{v:1,run_id:runId},options:undefined}]);
});

test('publishing result chains exactly one next work token and acknowledges current',async()=>{
 const sent=[],m=message();
 const env={ML_PUBLISH_QUEUE_ENABLED:'true',ML_PUBLISH_QUEUE:{send:async(body,options)=>sent.push({body,options})}};
 const handler=createPublicationQueueHandler({tick:async(_env,id)=>{assert.equal(id,runId);return {state:'publishing'};}});
 await handler({messages:[m]},env);
 assert.equal(m.state.acked,1);assert.deepEqual(m.state.retried,[]);
 assert.deepEqual(sent,[{body:{v:1,run_id:runId},options:undefined}]);
});

test('daily cap schedules the next token for the next Montevideo day',async()=>{
 const now=Date.parse('2026-10-17T01:00:00Z'),sent=[],m=message();
 const env={ML_PUBLISH_QUEUE_ENABLED:'true',ML_PUBLISH_QUEUE:{send:async(body,options)=>sent.push({body,options})}};
 const handler=createPublicationQueueHandler({tick:async()=>({state:'daily_cap_reached'})},{now:()=>now});
 await handler({messages:[m]},env);
 assert.equal(m.state.acked,1);
 assert.equal(secondsUntilMontevideoDay(now),7200);
 assert.equal(sent[0].options.delaySeconds,7200);
});

test('retryable consumer failure retries the same queue message without acking it',async()=>{
 const m=message(),env={ML_PUBLISH_QUEUE_ENABLED:'true',ML_PUBLISH_QUEUE:{send:async()=>{}}};
 const error=Object.assign(new Error('rate limited'),{status:429});
 const handler=createPublicationQueueHandler({tick:async()=>{throw error;}});
 await handler({messages:[m]},env);
 assert.equal(m.state.acked,0);
 assert.deepEqual(m.state.retried,[{delaySeconds:60}]);
});

test('terminal result stops the chain',async()=>{
 const sent=[],m=message();
 const env={ML_PUBLISH_QUEUE_ENABLED:'true',ML_PUBLISH_QUEUE:{send:async(...args)=>sent.push(args)}};
 const handler=createPublicationQueueHandler({tick:async()=>({state:'complete',counts:[{state:'published',n:20}]})});
 await handler({messages:[m]},env);
 assert.equal(m.state.acked,1);assert.deepEqual(sent,[]);
});
