import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { googleImageCheckScript, GOOGLE_IMAGE_PATH } from '../../scripts/admin-web-google-image-check.mjs';
import { normalizeMonitorRegistry, readMonitorCoverage } from '../_shared/admin-web-coverage.js';
import { coveragePanel } from '../_shared/admin-web-view.js';
import { normalizeCheckly } from '../../worker-monitor/index.js';

const id = '44444444-4444-4444-8444-444444444444';
const registry = Object.fromEntries(['sync','catalogo','portadas','google_imagen'].map((component,i) =>
  [`${String(i+1).repeat(8)}-${String(i+1).repeat(4)}-4${String(i+1).repeat(3)}-8${String(i+1).repeat(3)}-${String(i+1).repeat(12)}`,
    { environment:'production',component,path:['/api/status','/catalogo','/',GOOGLE_IMAGE_PATH][i],frequency:i<2?10:120 }]));

test('script enviado a Checkly falla por ausencia real y se recupera al aparecer Product.image', async () => {
  let run;
  const testFn = (_,fn) => { run=fn; }; testFn.setTimeout = () => {};
  const expect = (actual,message) => ({ toBe: wanted => assert.equal(actual,wanted,message), toEqual: wanted => assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(wanted)),message) });
  vm.runInNewContext(googleImageCheckScript(), { require: name => { assert.equal(name,'@playwright/test'); return {test:testFn,expect}; }, URL });
  const request = image => ({ get: async (url,options) => {
    assert.equal(url, `https://www.amadolibros.com${GOOGLE_IMAGE_PATH}`); assert.equal(options.maxRedirects,0);
    return { status:()=>200,text:async()=>`<meta property="og:image" content="logo"><script type="application/ld+json">${JSON.stringify({'@type':['Product','Book'],sku:'MLU651526046',...(image ? {image} : {})})}</script>` };
  } });
  await assert.rejects(run({request:request(null)}), /PRODUCT_IMAGE_MISSING/);
  await run({request:request('https://www.amadolibros.com/book-cover/MLU651526046/cover.jpg')});
});
test('el cuarto control es opcional durante despliegue y no admite rutas ni componentes arbitrarios', () => {
  assert.equal(normalizeMonitorRegistry(registry).length,4);
  assert.equal(normalizeMonitorRegistry(Object.fromEntries(Object.entries(registry).slice(0,3))).length,3);
  assert.throws(()=>normalizeMonitorRegistry({...registry,[id]:{...registry[id],path:'//untrusted.test'}}),/REGISTRY_INVALID/);
  assert.throws(()=>normalizeMonitorRegistry(Object.fromEntries(Object.entries(registry).slice(1))),/REGISTRY_INVALID/);
});
test('el panel muestra motivo cerrado y enlace; aviso firmado conserva componente y fecha', async () => {
  const now=new Date('2026-09-09T12:00:00Z');
  const result=await readMonitorCoverage({ CHECKLY_API_KEY:'PRIVATE',ADMIN_WEB_MONITOR_CHECKS_JSON:JSON.stringify(registry) },now,async url=>{
    if(url.endsWith('/v1/checks')) return Response.json(Object.entries(registry).map(([id,c])=>({id,activated:true,frequency:c.frequency})));
    const checkId=Object.keys(registry).find(id=>url.includes(id));
    return Response.json({entries:[{checkId,startedAt:now.toISOString(),hasFailures:checkId===id,hasErrors:false,
      browserCheckResult:{errors:['PRODUCT_IMAGE_MISSING PRIVATE_PAYLOAD']}}]});
  });
  assert.equal(result.rows[3].detail,'PRODUCT_IMAGE_MISSING');
  const html=coveragePanel(result);
  assert.match(html,/Ficha sin imagen para Google/); assert.ok(html.includes(`https://www.amadolibros.com${GOOGLE_IMAGE_PATH}`));
  assert.doesNotMatch(JSON.stringify(result)+html,/PRIVATE/);
  const event=normalizeCheckly({version:1,checkId:id,resultId:id,alertType:'ALERT_FAILURE',occurredAt:now.toISOString()},registry,'production',now);
  assert.equal(event.component,'google_imagen'); assert.equal(event.path,GOOGLE_IMAGE_PATH);
});
