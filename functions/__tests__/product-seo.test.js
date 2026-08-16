import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PRODUCT_SEO_IDS,
  productSeoFor,
  shouldIndexProduct,
  verifiedDuplicateCanonicalTarget,
} from '../_shared/product-seo.js';
import { renderPage } from '../libro/[[path]].js';

test('las 11 oportunidades GSC tienen snippets editoriales propios', () => {
  assert.equal(PRODUCT_SEO_IDS.length, 11);
  assert.equal(productSeoFor('MLU1416777650').title, 'Murdoku en Uruguay: 80 acertijos de lógica');

  const html = renderPage({
    id: 'MLU1416777650',
    title: 'Título comercial largo que permanece visible',
    author: 'Manuel Garand',
    isbn: '9791387869380',
    status: 'paused',
    available_quantity: 0,
  }, 'titulo-comercial-largo-que-permanece-visible', false, '');

  assert.match(html, /<title>Murdoku en Uruguay: 80 acertijos de lógica \| Amado Libros<\/title>/);
  assert.match(html, /<h1>Título comercial largo que permanece visible<\/h1>/);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /Consultá por Murdoku de Manuel Garand en Uruguay/);
});

test('sólo oportunidades verificadas permanecen indexables sin stock', () => {
  const paused = id => ({ id, status: 'paused', available_quantity: 0 });
  assert.equal(shouldIndexProduct(paused('MLU1416777650')), true);
  assert.equal(shouldIndexProduct(paused('MLU653980087')), true);
  assert.equal(shouldIndexProduct(paused('MLU676002408')), false);
  assert.equal(shouldIndexProduct({ id: 'MLU1', status: 'active', available_quantity: 1 }), true);
  assert.equal(shouldIndexProduct({ id: 'MLU1416777650', status: 'active', available_quantity: 1 }, true), false);
});

test('consolida sólo duplicados cuyo ISBN, título y destino activo coinciden', () => {
  const source = {
    id: 'MLU704333012',
    title: 'Libro Reflexiones Sobre Vivir En Compasion',
    isbn: '9788412027082',
    status: 'active',
    available_quantity: 2,
  };
  const target = {
    ...source,
    id: 'MLU704333014',
    status: 'active',
    available_quantity: 2,
  };

  assert.equal(verifiedDuplicateCanonicalTarget(source, [source, target]), target);
  assert.equal(verifiedDuplicateCanonicalTarget(source, [source, { ...target, isbn: '9780000000000' }]), null);
  assert.equal(verifiedDuplicateCanonicalTarget(source, [source, { ...target, available_quantity: 0 }]), null);
});
