import test from 'node:test';
import assert from 'node:assert/strict';

import { enrichByRequestProductHtml } from '../libro/_middleware.js';
import { PAUSED_SEO_COHORT } from '../_shared/paused-seo-cohort.js';

const COHORT_PRODUCT_ID = PAUSED_SEO_COHORT[0].id;

function productHtml({ inStock = false } = {}) {
  return `<!doctype html>
<html lang="es">
<head>
  <style>.order-box span{font-weight:700}</style>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Inicio","item":"https://www.amadolibros.com/"},{"@type":"ListItem","position":2,"name":"Libro de prueba"}]}</script>
</head>
<body>
  <nav><a href="/">Inicio</a> › <span>Libro de prueba</span></nav>
  <main>
    ${inStock ? '<span class="badge in-stock">En stock</span>' : ''}
    <div class="order-box">
      <strong>¿Buscás este libro?</strong>
      <span>Podemos intentar conseguirlo por encargo. Consultanos y verificamos disponibilidad, edición y precio.</span>
    </div>
  </main>
</body>
</html>`;
}

test('la ficha por encargo comunica la demora comercial aprobada antes del CTA', () => {
  const html = enrichByRequestProductHtml(productHtml(), COHORT_PRODUCT_ID);

  assert.match(html, /Demora estimada: 15 a 20 días desde la confirmación\./);
  assert.match(html, /Salvo demoras del proveedor, courier o aduana\./);
  assert.match(html, /Antes de avanzar verificamos disponibilidad, edición y precio\./);
  assert.doesNotMatch(html, /Podemos intentar conseguirlo por encargo/);
  assert.doesNotMatch(html, /días hábiles|garantizad/i);
  assert.match(html, /class="order-lead-time"/);
  assert.match(html, /class="order-hub-links"/);
});

test('una ficha que volvió a stock no recibe plazo de encargo', () => {
  const source = productHtml({ inStock: true });
  const html = enrichByRequestProductHtml(source, COHORT_PRODUCT_ID);

  assert.equal(html, source);
  assert.doesNotMatch(html, /15 a 20 días/);
});

test('una ficha fuera de la cohorte SEO queda intacta', () => {
  const source = productHtml();
  const html = enrichByRequestProductHtml(source, 'MLU999999999');

  assert.equal(html, source);
});

test('el enriquecimiento es idempotente', () => {
  const first = enrichByRequestProductHtml(productHtml(), COHORT_PRODUCT_ID);
  const second = enrichByRequestProductHtml(first, COHORT_PRODUCT_ID);

  assert.equal(second, first);
  assert.equal((second.match(/15 a 20 días/g) || []).length, 1);
});
