import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalProductRedirectUrl } from '../libro/[[path]].js';

test('slug faltante redirige a la URL canónica', () => {
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

test('slug incorrecto elimina layout obsoleto pero conserva otros parámetros', () => {
  assert.equal(
    canonicalProductRedirectUrl({
      requestUrl: 'https://www.amadolibros.com/libro/MLU479210053/x?layout=grid&utm_source=test',
      navigationBase: 'https://www.amadolibros.com',
      id: 'MLU479210053',
      providedSlug: 'x',
      canonicalSlug: 'titulo-canonico',
    }),
    'https://www.amadolibros.com/libro/MLU479210053/titulo-canonico?utm_source=test',
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

test('producción puede colapsar non-www al host canónico en un solo salto', () => {
  assert.equal(
    canonicalProductRedirectUrl({
      requestUrl: 'https://amadolibros.com/libro/MLU1/x?foo=bar',
      navigationBase: 'https://www.amadolibros.com',
      id: 'MLU1',
      providedSlug: 'x',
      canonicalSlug: 'mismo-slug',
    }),
    'https://www.amadolibros.com/libro/MLU1/mismo-slug?foo=bar',
  );
});
