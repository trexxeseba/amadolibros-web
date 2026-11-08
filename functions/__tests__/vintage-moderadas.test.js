import test from 'node:test';
import assert from 'node:assert/strict';
import {flatten,elementIds,origin} from '../../scripts/vintage-cloud/moderadas.mjs';

test('infractions are flattened, their listings found and the origin of each listing told',()=>{
 assert.deepEqual(flatten({id:1,reason:{id:'IP',name:'Propiedad'},tags:['a']}),{id:1,'reason.id':'IP','reason.name':'Propiedad'});
 assert.deepEqual(elementIds({element:{id:'MLU1234567'},related:['MLU7654321','MLU1234567']}),['MLU1234567','MLU7654321']);
 assert.equal(origin(undefined),'fuera_de_la_campaña');
 assert.equal(origin({created_at:Date.parse('2026-11-07T00:00:00Z')}),'nube');
 assert.equal(origin({created_at:Date.parse('2026-10-25T00:00:00Z')}),'pc_o_web');
});
