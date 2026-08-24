import test from 'node:test';
import assert from 'node:assert/strict';

import {
  verifyBookEnrichmentFeed,
  verifyBookEnrichmentHtml,
} from '../../scripts/seo/book-enrichment-live-check.mjs';

const record = {
  isbn: '9788490739808',
  editorial: {
    heading: 'Qué contiene esta edición',
    decision_heading: '¿Esta es la edición que buscás?',
    merchant_description: 'La Biblia Palabra de Vida, edición Hispanoamérica de Editorial Verbo Divino.',
  },
  facts: { publisher: 'Editorial Verbo Divino' },
};

test('el gate acepta ficha y oferta completas', () => {
  const html = `<h2>Qué contiene esta edición</h2><p>Editorial Verbo Divino · 9788490739808</p><h3>¿Esta es la edición que buscás?</h3><div>MLU724888358</div>`;
  const feed = `<item><g:id>MLU724888358</g:id><g:description>La Biblia Palabra de Vida, edición Hispanoamérica de Editorial Verbo Divino.</g:description><g:gtin>9788490739808</g:gtin><g:price>1950 UYU</g:price><g:availability>in stock</g:availability><g:link>https://www.amadolibros.com/libro/MLU724888358/x</g:link><g:image_link>https://www.amadolibros.com/book-cover/MLU724888358/cover.jpg</g:image_link></item>`;
  assert.deepEqual(verifyBookEnrichmentHtml(html, record, 'MLU724888358'), []);
  assert.deepEqual(verifyBookEnrichmentFeed(feed, record, 'MLU724888358'), []);
});

test('Merchant busca el bloque del MLU exacto y no mezcla duplicados anteriores', () => {
  const feed = `<item><g:id>MLU111111111</g:id><g:description>Otra edición</g:description></item>
    <item><g:id>MLU724888358</g:id><g:description>La Biblia Palabra de Vida, edición Hispanoamérica de Editorial Verbo Divino.</g:description><g:gtin>9788490739808</g:gtin><g:price>1950 UYU</g:price><g:availability>in stock</g:availability><g:link>x</g:link><g:image_link>y</g:image_link></item>`;
  assert.deepEqual(verifyBookEnrichmentFeed(feed, record, 'MLU724888358'), []);
});

test('el gate falla ante copy ausente, autor genérico o pérdida comercial', () => {
  const htmlFailures = verifyBookEnrichmentHtml('<p>Desconocido</p><p>MLU724888358</p>', record, 'MLU724888358');
  assert.ok(htmlFailures.includes('falta el encabezado editorial'));
  assert.ok(htmlFailures.includes('aparece autoría genérica'));
  const feedFailures = verifyBookEnrichmentFeed('<rss></rss>', record, 'MLU724888358');
  assert.deepEqual(feedFailures, ['falta la oferta en Merchant']);
});
