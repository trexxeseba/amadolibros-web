import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalProductRedirectUrl } from '../libro/[[path]].js';

test('slug faltante redirige a la URL canónica sin query', () => {
  assert.equal(
    canonicalProductRedirectUrl({
      requestUrl: 'https://www.amadolibros.com/libro/MLU479210053',
      navigationBase: 'https://www.amadolibros.com',
      id: 'MLU479210053',
      providedSlug: null,
      canonicalSlug: 'titulo-canonico',
    }),
    'https://www.amadolibros.com/libro/MLU479210053/titulo-canonico',
  );
});

test('slug incorrecto redirige al canónico y conserva query string', () => {
  assert.equal(
    canonicalProductRedirectUrl({
      requestUrl: 'https://www.amadolibros.com/libro/MLU479210053/x?utm_source=test&foo=bar',
      navigationBase: 'https://www.amadolibros.com',
      id: 'MLU479210053',
      providedSlug: 'x',
      canonicalSlug: 'titulo-canonico',
    }),
    'https://www.amadolibros.com/libro/MLU479210053/titulo-canonico?utm_source=test&foo=bar',
  );
});

test('slug correcto no redirige, incluso con query string', () => {
  assert.equal(
    canonicalProductRedirectUrl({
      requestUrl: 'https://www.amadolibros.com/libro/MLU479210053/titulo-canonico?utm_source=test',
      navigationBase: 'https://www.amadolibros.com',
      id: 'MLU479210053',
      providedSlug: 'titulo-canonico',
      canonicalSlug: 'titulo-canonico',
    }),
    null,
  );
});

test('no genera loop cuando slug ya coincide exactamente', () => {
  assert.equal(
    canonicalProductRedirectUrl({
      requestUrl: 'https://www.amadolibros.com/libro/MLU1/mismo-slug',
      navigationBase: 'https://www.amadolibros.com',
      id: 'MLU1',
      providedSlug: 'mismo-slug',
      canonicalSlug: 'mismo-slug',
    }),
    null,
  );
});
