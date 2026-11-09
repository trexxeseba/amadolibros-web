import test from 'node:test';
import assert from 'node:assert/strict';
import {correr} from '../../scripts/vintage-cloud/vigia.mjs';

test('the standalone watcher reports what the watcher found and never publishes',async()=>{
 const out=await correr({vigia:async()=>({baseline:false,nuevas_pi:0,freno:null})});
 assert.deepEqual(out,{ok:true,vigia_pi:{baseline:false,nuevas_pi:0,freno:null}});
});

test('a watcher failure is reported with a short code and no message text',async()=>{
 const out=await correr({vigia:async()=>{throw Object.assign(new Error('token abc secret'),{code:'ml_http_401'});}});
 assert.equal(out.ok,false);assert.equal(out.error,'ml_http_401');
 assert.ok(!/abc|secret/.test(JSON.stringify(out)));
});
