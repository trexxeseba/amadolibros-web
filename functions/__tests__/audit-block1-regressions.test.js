import test from 'node:test';
import assert from 'node:assert/strict';

import {
  absoluteUrls,
  decodeHtml,
  paginationVerdict,
  summarizeUrlChecks,
} from '../../scripts/audit/_lib.mjs';

test('decodifica entidades HTML/XML antes de construir URLs', () => {
  assert.equal(
    decodeHtml('/libros/psicologia?page=2&amp;subcategoria=autismo'),
    '/libros/psicologia?page=2&subcategoria=autismo',
  );
  assert.deepEqual(
    absoluteUrls('<url><loc>https://example.com/catalogo?page=2&amp;orden=asc</loc></url>'),
    ['https://example.com/catalogo?page=2&orden=asc'],
  );
});

test('un redirect seguido hasta 200 nunca cuenta como respuesta 200 directa', () => {
  const summary = summarizeUrlChecks([
    { status: 200, redirected: false },
    { status: 308, redirected: false },
    { status: 200, redirected: true },
  ]);
  assert.deepEqual(summary.totals, {
    ok200: 1,
    notOk: 2,
    redirects3xx: 2,
    errors4xx: 0,
    errors5xx: 0,
    networkFailures: 0,
  });
});

test('declara diagnóstico mixto cuando coexisten profundidad y falta de cobertura', () => {
  assert.match(paginationVerdict({
    anchorPaginationLinks: 20,
    truncated: false,
    reachedCount: 504,
    unreachedCount: 76,
    medianDepth: 16,
  }), /MIXTO H1 \+ H2/);
});

test('mantiene separados H1, H2 y H3 cuando la evidencia no es mixta', () => {
  assert.match(paginationVerdict({
    anchorPaginationLinks: 20,
    truncated: false,
    reachedCount: 580,
    unreachedCount: 0,
    medianDepth: 16,
  }), /^H1/);
  assert.match(paginationVerdict({
    anchorPaginationLinks: 20,
    truncated: false,
    reachedCount: 504,
    unreachedCount: 76,
    medianDepth: 3,
  }), /^H2/);
  assert.match(paginationVerdict({
    anchorPaginationLinks: 0,
    truncated: false,
    reachedCount: 0,
    unreachedCount: 580,
    medianDepth: null,
  }), /^H3/);
});
