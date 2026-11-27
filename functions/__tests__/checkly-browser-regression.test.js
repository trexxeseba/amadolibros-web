import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const code=readFileSync(new URL('../../scripts/monitoring/checkly-browser.spec.cjs',import.meta.url),'utf8');
test('book URLs accept the canonical title, reject other routes and extra path segments',()=>{
 const literal=code.split('\n').find(l=>l.includes('expect(path).toMatch(')).match(/toMatch\((\/.*\/)\)/)[1];
 const rx=vm.runInNewContext(literal);
 for(const good of ['/libro/MLU1001381834','/libro/MLU1001381834/','/libro/MLU1001381834/falcones-la-reina-descalza'])assert.ok(rx.test(good),good);
 for(const bad of ['/libro/no-id','/carrito','/libro/MLU1/a/b','/libro/MLU1//'])assert.equal(rx.test(bad),false,bad);
});
test('images outside the carousel viewport do not count as visible; visible broken images remain checked',()=>{
 const line=code.split('\n').find(l=>l.includes('const r = i.getBoundingClientRect(); return'));
 const predicate=vm.runInNewContext('(r,innerWidth,innerHeight)=>'+line.split('return ')[1].replace(/;$/,''));
 const r={width:200,height:280,left:1544,right:1744,top:20,bottom:300};
 assert.equal(predicate(r,1365,900),false);
 assert.equal(predicate({...r,left:450,right:650},390,844),false);
 assert.equal(predicate({...r,left:350,right:550},390,844),true);
 assert.match(code,/!i\.complete \|\| i\.naturalWidth === 0/);
 assert.match(code,/timeout: 8000/);
});
test('CSS banner URLs are actually extracted from browser-computed backgrounds',()=>{
 const literal=code.split('\n').find(l=>l.includes('backgroundImage.matchAll')).match(/matchAll\((\/.*\/g)\)/)[1];
 const rx=vm.runInNewContext(literal);
 const matches=[...'url("https://www.amadolibros.com/banner.webp")'.matchAll(rx)];
 assert.equal(matches.length,1);assert.equal(matches[0][1],'https://www.amadolibros.com/banner.webp');
});
