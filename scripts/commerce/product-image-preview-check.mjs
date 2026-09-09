import assert from 'node:assert/strict';
import { inspectProductImages } from '../../shared/product-image-audit.js';
const base = new URL(process.env.COMMERCE_BASE_URL);
assert.match(base.hostname, /(?:^|\.)amadolibros-web\.pages\.dev$/);
assert.equal(base.protocol, 'https:');
const path = '/libro/MLU651526046/big-english-1-british-pupil-s-book-pearson';
const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30000) });
assert.equal(response.status, 200, 'Ficha de Preview no disponible');
assert.equal(new URL(response.url).origin, base.origin, 'La comprobación salió del Preview');
const html = await response.text();
assert.match(html, /name="robots"[^>]+noindex/);
const result = inspectProductImages(html);
assert.deepEqual(result.issues, []);
assert.ok(result.products.some(p => p.sku === 'MLU651526046' && p.images.length > 0));
console.log(JSON.stringify({ status: 'reported_product_preview_verified', url: response.url,
  checkedAt: new Date().toISOString(), productId: 'MLU651526046', imagePresent: true, noindex: true }));
// Clasificar dos páginas señaladas por la nueva lectura estricta del auditor.
// No altera el veredicto de la auditoría ni modifica los datos de las fichas.
for (const path of ['/libro/MLU603140534/astromostra-guia-astrologica-para-sobrevivir-en-la-tierra',
  '/libro/MLU609552990/realismo-imaginativo-james-gurney']) {
  const r = await fetch(new URL(path,base),{signal:AbortSignal.timeout(30000)});
  const body = await r.text();
  console.log(JSON.stringify({status:'product_schema_audit_diagnostic',path,httpStatus:r.status,
    inspection:inspectProductImages(body,{allowBookOnly:true}),
    ldScriptTags:[...body.matchAll(/<script\b[^>]*>/gi)].map(m=>m[0]).filter(t=>t.includes('ld+json')).map(t=>t.slice(0,180))}));
}
