import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildIndexNowChangeSet,
  INDEXNOW_CATEGORY_PATHS,
  INDEXNOW_ENDPOINT,
  submitIndexNow,
} from '../indexnow.js';

const ORIGIN = 'https://www.amadolibros.com';
const KEY = '944e65e97fd0a8c242c495ccf458d3c3';

function item(id, overrides = {}) {
  return {
    id,
    title: `Libro ${id}`,
    author: 'Autora',
    price: 1000,
    status: 'active',
    available_quantity: 1,
    pictures: [`https://img.example/${id}.jpg`],
    ...overrides,
  };
}

test('sin baseline no presenta las 7.000 fichas como nuevas', () => {
  const changes = buildIndexNowChangeSet(null, {
    items: [item('MLU1'), item('MLU2')],
  }, ORIGIN);

  assert.equal(changes.baseline_available, false);
  assert.equal(changes.changed_products, 0);
  assert.equal(changes.evergreen_urls, 9);
  assert.equal(changes.urlList.length, 9);
  assert.ok(changes.urlList.includes(`${ORIGIN}/catalogo`));
  assert.ok(INDEXNOW_CATEGORY_PATHS.every(path => changes.urlList.includes(`${ORIGIN}${path}`)));
  assert.equal(changes.urlList.some(url => url.includes('/libro/')), false);
});

test('envía sólo altas, reactivaciones y cambios reales de fichas indexables', () => {
  const previous = {
    items: [
      item('MLU1'),
      item('MLU2'),
      item('MLU3', { available_quantity: 0 }),
      item('MLU4'),
    ],
  };
  const next = {
    items: [
      item('MLU1'),
      item('MLU2', { price: 1200 }),
      item('MLU3', { available_quantity: 2 }),
      item('MLU4', { available_quantity: 0 }),
      item('MLU5', { title: 'Título nuevo con tilde' }),
      item('MLU6', { status: 'paused', available_quantity: 0 }),
    ],
  };

  const changes = buildIndexNowChangeSet(previous, next, ORIGIN);
  const productUrls = changes.urlList.filter(url => url.includes('/libro/'));

  assert.equal(changes.baseline_available, true);
  assert.equal(changes.changed_products, 3);
  assert.deepEqual(productUrls, [
    `${ORIGIN}/libro/MLU2/libro-mlu2`,
    `${ORIGIN}/libro/MLU3/libro-mlu3`,
    `${ORIGIN}/libro/MLU5/titulo-nuevo-con-tilde`,
  ]);
});

test('POST por lote usa host, clave, keyLocation y sólo URLs del dominio canónico', async () => {
  let captured;
  const result = await submitIndexNow({
    INDEXNOW_ENABLED: 'true',
    INDEXNOW_KEY: KEY,
    CANONICAL_ORIGIN: ORIGIN,
  }, { items: [] }, { items: [item('MLU7')] }, {
    fetchFn: async (url, options) => {
      captured = { url, options };
      return { status: 202 };
    },
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  const body = JSON.parse(captured.options.body);
  assert.equal(captured.url, INDEXNOW_ENDPOINT);
  assert.equal(captured.options.method, 'POST');
  assert.equal(body.host, 'www.amadolibros.com');
  assert.equal(body.key, KEY);
  assert.equal(body.keyLocation, `${ORIGIN}/${KEY}.txt`);
  assert.ok(body.urlList.every(url => url.startsWith(`${ORIGIN}/`)));
  assert.equal(body.urlList.some(url => /favicon|robots|\/images\//.test(url)), false);
  assert.equal(result.status, 'sent');
  assert.equal(result.http_status, 202);
});

test('una configuración inválida no llama a la red', async () => {
  let calls = 0;
  const result = await submitIndexNow({
    INDEXNOW_ENABLED: 'true',
    INDEXNOW_KEY: 'mala',
    CANONICAL_ORIGIN: ORIGIN,
  }, null, { items: [] }, {
    fetchFn: async () => { calls++; return { status: 200 }; },
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'invalid-config');
  assert.equal(calls, 0);
});

test('wrangler y el archivo público exponen exactamente la misma clave', () => {
  const workerRoot = fileURLToPath(new URL('../', import.meta.url));
  const wrangler = readFileSync(`${workerRoot}/wrangler.toml`, 'utf8');
  const match = wrangler.match(/INDEXNOW_KEY\s*=\s*"([A-Za-z0-9-]+)"/);
  assert.ok(match);
  const publicFile = fileURLToPath(new URL(`../../astro-front/public/${match[1]}.txt`, import.meta.url));
  assert.equal(readFileSync(publicFile, 'utf8').trim(), match[1]);
});
