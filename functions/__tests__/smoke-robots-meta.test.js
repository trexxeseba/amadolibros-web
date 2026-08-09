import test from 'node:test';
import assert from 'node:assert/strict';
import smoke from '../../scripts/smoke-production.js';

test('smoke SEO espera el robots real de las búsquedas: noindex, follow', () => {
  const route = smoke.SMOKE_ROUTES.find(
    item => item.path === '/catalogo?q=zzzinexistente999'
  );
  assert.ok(route);
  assert.equal(route.robots, 'noindex, follow');
});

test('hasHtmlMeta reconoce noindex, follow sin rebajarlo a noindex literal', () => {
  const html = '<meta name="robots" content="noindex, follow">';
  assert.equal(smoke.hasHtmlMeta(html, 'robots', 'noindex, follow'), true);
  assert.equal(smoke.hasHtmlMeta(html, 'robots', 'noindex'), false);
});
