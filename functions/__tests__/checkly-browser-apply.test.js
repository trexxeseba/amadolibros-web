import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {approvedUpdate,hash,BROWSER_ID,AFTER} from '../../scripts/monitoring/checkly-browser-apply.mjs';
const proposed=readFileSync(new URL('../../scripts/monitoring/checkly-browser.spec.cjs',import.meta.url),'utf8');
const c={id:BROWSER_ID,name:'Amado - portadas banners y ficha',checkType:'BROWSER',script:proposed};
test('approved browser update is idempotent for the reviewed script',()=>{assert.equal(hash(proposed),AFTER);assert.equal(approvedUpdate(c,proposed),null);});
test('cannot update another check or an unreviewed script',()=>{assert.throws(()=>approvedUpdate({...c,id:'other'},proposed),/UNEXPECTED_CHECK/);assert.throws(()=>approvedUpdate(c,proposed+'//change'),/UNREVIEWED_PROPOSAL/);});
test('concurrent changes to the live script require a new review',()=>{assert.throws(()=>approvedUpdate({...c,script:'changed'},proposed),/LIVE_SCRIPT_CHANGED/);});

