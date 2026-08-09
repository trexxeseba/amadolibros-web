import test from 'node:test';
import assert from 'node:assert/strict';

import {
  conditionalResponse,
  ifNoneMatchMatches,
  representationEtag,
} from '../_shared/http-conditional.js';

test('ETag es determinístico para la representación real', async () => {
  const a = await representationEtag('<html>uno</html>');
  const b = await representationEtag('<html>uno</html>');
  const c = await representationEtag('<html>dos</html>');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^"sha256-[0-9a-f]{64}"$/);
});

test('If-None-Match reconoce match exacto, lista, weak y wildcard', async () => {
  const etag = await representationEtag('abc');
  assert.equal(ifNoneMatchMatches(etag, etag), true);
  assert.equal(ifNoneMatchMatches(`"otro", ${etag}`, etag), true);
  assert.equal(ifNoneMatchMatches(`W/${etag}`, etag), true);
  assert.equal(ifNoneMatchMatches('*', etag), true);
  assert.equal(ifNoneMatchMatches('"otro"', etag), false);
});

test('primer GET devuelve 200 + ETag + body', async () => {
  const response = await conditionalResponse(
    new Request('https://www.amadolibros.com/catalogo?page=2'),
    '<html>p2</html>',
    { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600' } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('etag'), /^"sha256-/);
  assert.equal(await response.text(), '<html>p2</html>');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
});

test('mismo contenido + If-None-Match devuelve 304 sin body', async () => {
  const body = '<html>igual</html>';
  const etag = await representationEtag(body);
  const response = await conditionalResponse(
    new Request('https://www.amadolibros.com/libro/MLU1/uno', {
      headers: { 'If-None-Match': etag },
    }),
    body,
    { headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=3600' } },
  );
  assert.equal(response.status, 304);
  assert.equal(response.headers.get('etag'), etag);
  assert.equal(await response.text(), '');
  assert.equal(response.headers.get('cache-control'), 'public, max-age=3600');
});

test('cambio de dato o markup cambia ETag y vuelve 200', async () => {
  const oldBody = '<html><p>Precio 100</p></html>';
  const oldEtag = await representationEtag(oldBody);
  const changed = '<html><p>Precio 101</p></html>';
  const response = await conditionalResponse(
    new Request('https://www.amadolibros.com/libro/MLU1/uno', {
      headers: { 'If-None-Match': oldEtag },
    }),
    changed,
    { headers: { 'content-type': 'text/html' } },
  );
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.get('etag'), oldEtag);
  assert.equal(await response.text(), changed);
});

test('representaciones de páginas distintas no comparten ETag', async () => {
  const page2 = await representationEtag('<html>página 2: A B</html>');
  const page3 = await representationEtag('<html>página 3: C D</html>');
  assert.notEqual(page2, page3);
});

test('status no-200 y enable=false no agregan validator', async () => {
  const error = await conditionalResponse(
    new Request('https://www.amadolibros.com/catalogo?page=999999'),
    'No encontrado',
    { status: 404, headers: { 'content-type': 'text/plain' } },
  );
  assert.equal(error.status, 404);
  assert.equal(error.headers.get('etag'), null);

  const filtered = await conditionalResponse(
    new Request('https://www.amadolibros.com/catalogo?q=x'),
    '<html>filtro</html>',
    { enable: false, headers: { 'content-type': 'text/html' } },
  );
  assert.equal(filtered.status, 200);
  assert.equal(filtered.headers.get('etag'), null);
});
