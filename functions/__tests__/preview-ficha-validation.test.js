import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, expectedChecks, productSchema } from '../../scripts/seo/preview-ficha-validation.mjs';

const html = (extra = '') => `<html><body>
  <p>Editorial: Oxford University Press</p><p>496 páginas</p>${extra}
  <script type="application/ld+json">{"@type":"Product","numberOfPages":496,"publisher":{"name":"Oxford University Press"}}</script>
</body></html>`;

test('se extrae el Product del JSON-LD entre varios bloques', () => {
  const conVarios = `<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>${html()}`;
  assert.equal(productSchema(conVarios)['@type'], 'Product');
  assert.equal(productSchema('<html></html>'), null);
});

test('sólo se exige lo que el lote realmente aporta', () => {
  assert.deepEqual(expectedChecks({ publisher: 'X' }).map(c => c.campo), ['publisher']);
  assert.deepEqual(expectedChecks({}).map(c => c.campo), []);
});

test('un campo presente en HTML y JSON-LD pasa', () => {
  const { resultados, tieneSchema } = evaluate(html(), { publisher: 'Oxford University Press', pages: 496 });
  assert.equal(tieneSchema, true);
  for (const r of resultados) {
    assert.equal(r.enHtml, true, r.campo);
    assert.equal(r.enJsonLd, true, r.campo);
  }
});

test('un campo ausente se detecta como falla, no se da por bueno', () => {
  const { resultados } = evaluate('<html><body>sin datos</body></html>', { publisher: 'Oxford University Press' });
  assert.equal(resultados[0].enHtml, false);
  assert.equal(resultados[0].enJsonLd, false);
});

test('un campo sin representación en JSON-LD se valida sólo por HTML', () => {
  const { resultados } = evaluate(html('<p>Año: 2021</p>'), { publication_year: '2021' });
  assert.equal(resultados[0].enHtml, true);
  assert.equal(resultados[0].enJsonLd, null);
});
