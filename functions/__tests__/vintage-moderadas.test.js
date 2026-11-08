import test from 'node:test';
import assert from 'node:assert/strict';
import {classify,isModerated} from '../../scripts/vintage-cloud/moderadas.mjs';

test('moderation states are detected and each listing is tagged with its origin and catalog type',()=>{
 assert.equal(isModerated({status:'active',sub_status:[],tags:[]}),false);
 assert.equal(isModerated({status:'under_review',sub_status:[]}),true);
 assert.equal(isModerated({status:'paused',sub_status:['forbidden']}),true);
 assert.equal(isModerated({status:'paused',sub_status:['out_of_stock']}),false);
 const item={id:'MLU1',title:'Libro',status:'inactive',sub_status:['forbidden'],catalog_listing:false,date_created:'2026-11-07T12:00:00.000Z',attributes:[{id:'BOOK_PUBLISHER',value_name:'Editorial X'}],pictures:[{}]};
 assert.deepEqual({...classify(item,{created_at:Date.parse('2026-11-07T12:00:00Z')})}.origen,'nube');
 assert.equal(classify(item,{created_at:Date.parse('2026-10-25T12:00:00Z')}).origen,'pc_o_web');
 assert.equal(classify(item,undefined).origen,'fuera_de_la_campaña');
 assert.equal(classify(item).editorial,'Editorial X');assert.equal(classify(item).catalogo,false);assert.equal(classify(item).dia,'2026-11-07');
});
