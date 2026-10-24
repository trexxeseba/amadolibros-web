import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedPath,makeDiagnosticReader} from '../mercadolibre/read-three-catalog-diagnostics.mjs';
test('only fixed catalog, UP and seller resources are readable',()=>{
 for(const path of ['/items/MLU1431940402?include_internal_attributes=true','/products/MLU73380330','/user-products/MLUU2753362935','/public/buybox/sync/MLU701279056'])assert.ok(allowedPath(path));
 for(const path of ['/items/MLU99999999','/products/MLU99999999','/users/2341378249/items/search','/oauth/token','/users/440298103/items/search?user_product_id=MLUU999999&limit=100&offset=0','https://evil.example/users/440298103/items/search?user_product_id=MLUU2753362935&limit=100&offset=0'])assert.ok(!allowedPath(path));
});
test('writes and synchronization POST are rejected before any fetch',async()=>{
 let calls=0;const get=makeDiagnosticReader('test',async()=>{calls++;});
 await assert.rejects(get('/products/MLU73380330','PUT'),/forbidden/);await assert.rejects(get('/public/buybox/sync/MLU701279056','POST'),/forbidden/);assert.equal(calls,0);
});
test('empty successful responses and permission errors do not prove success',async()=>{
 const empty=makeDiagnosticReader('test',async(_url,o)=>{assert.equal(o.method,'GET');return new Response('',{status:200});});assert.equal((await empty('/products/MLU73380330')).ok,false);
 const denied=makeDiagnosticReader('test',async()=>new Response('{"error":"forbidden"}',{status:403}));const result=await denied('/products/MLU73380330');assert.equal(result.ok,false);assert.equal(result.status,403);
});
