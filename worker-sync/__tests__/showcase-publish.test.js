import test from 'node:test';
import assert from 'node:assert/strict';

import {
  prepareShowcaseCatalog,
  publishToR2,
} from '../r2-publish.js';

function item(index, overrides = {}) {
  return {
    id: `MLU${200000000 + index}`,
    title: `Libro seleccionado ${index}`,
    author: `Autor ${index}`,
    price: 1200 + index,
    currency: 'UYU',
    status: 'active',
    available_quantity: 1,
    condition: 'new',
    domain_id: 'MLU-BOOKS',
    pictures: [`https://img/${index}.jpg`],
    bibliographic: {},
    ...overrides,
  };
}

function catalog(count = 1200) {
  return {
    total: count,
    updated_at: '2026-08-20T12:00:00.000Z',
    items: Array.from({ length: count }, (_, index) => item(index)),
  };
}

test('prepara exactamente las 1000 mejores ediciones activas', () => {
  const value = catalog(1200);
  const syncMeta = {};
  const { cohort, metrics } = prepareShowcaseCatalog(value, syncMeta);

  assert.equal(cohort.schema_version, 1);
  assert.equal(cohort.total, 1000);
  assert.equal(cohort.ids.length, 1000);
  assert.equal(new Set(cohort.ids).size, 1000);
  assert.equal(metrics.selected_items, 1000);
  assert.equal(value.items.filter(entry => entry.showcase_rank).length, 1000);
  assert.equal(value.data_quality.showcase_selection.selected_items, 1000);
  assert.equal(syncMeta.showcase_selection.selected_items, 1000);
  assert.deepEqual(
    value.items
      .filter(entry => entry.showcase_rank)
      .map(entry => entry.showcase_rank)
      .sort((a, b) => a - b),
    Array.from({ length: 1000 }, (_, index) => index + 1),
  );
});

test('la prioridad editorial verificada gana sin inventar señales de demanda', () => {
  const priority = item(1, {
    id: 'MLU633557235',
    title: 'Padres fuertes, hijas felices',
    author: null,
    pictures: [],
    pages: null,
    bibliographic: null,
  });
  const richer = item(2, {
    description: 'Descripción extensa y real. '.repeat(80),
    pictures: ['a', 'b', 'c', 'd'],
    pages: 500,
    isbn: '9788496836693',
    bibliographic: { language: 'Español', format: 'Tapa dura' },
  });
  const value = {
    total: 2,
    updated_at: '2026-08-20T12:00:00.000Z',
    items: [richer, priority],
  };

  const { cohort } = prepareShowcaseCatalog(value);
  assert.equal(cohort.ids[0], 'MLU633557235');
  assert.equal(priority.showcase_rank, 1);
});

test('no incorpora pausados ni repite la misma edición', () => {
  const original = item(1, {
    isbn: '9788496836693',
    available_quantity: 1,
  });
  const representative = item(2, {
    isbn: '9788496836693',
    available_quantity: 9,
    pictures: ['a', 'b', 'c'],
  });
  const paused = item(3, {
    status: 'paused',
    available_quantity: 0,
  });
  const value = {
    total: 3,
    updated_at: '2026-08-20T12:00:00.000Z',
    items: [original, representative, paused],
  };

  const { cohort, metrics } = prepareShowcaseCatalog(value);
  assert.deepEqual(cohort.ids, [representative.id]);
  assert.equal(metrics.duplicate_editions_excluded, 1);
  assert.equal(paused.showcase_rank, undefined);
  assert.equal(original.showcase_rank, undefined);
});

test('publica staging, valida readback y promueve catálogo + meta + cohorte como último puntero', async () => {
  const objects = new Map();
  const writes = [];
  const env = {
    CATALOG_R2: {
      async put(key, body, options) {
        writes.push({ key, body, options });
        objects.set(key, body);
      },
      async get(key) {
        const body = objects.get(key);
        return body == null ? null : {
          async text() { return body; },
        };
      },
    },
  };
  const value = catalog(1005);
  const syncMeta = { status: 'success' };

  await publishToR2(env, value, syncMeta);

  assert.deepEqual(writes.map(write => write.key), [
    'staging/catalog.json',
    'staging/meta.json',
    'staging/showcase-cohort.json',
    'catalog.json',
    'meta.json',
    'showcase/v1/cohort.json',
  ]);
  const cohort = JSON.parse(objects.get('showcase/v1/cohort.json'));
  const liveCatalog = JSON.parse(objects.get('catalog.json'));
  assert.equal(cohort.total, 1000);
  assert.equal(liveCatalog.data_quality.showcase_selection.selected_items, 1000);
  assert.equal(syncMeta.showcase_selection.selected_items, 1000);
  assert.equal(writes[5].options.httpMetadata.cacheControl, 'public, max-age=3600');
});

test('si el readback de la cohorte falla no toca ningún archivo live', async () => {
  const objects = new Map();
  const writes = [];
  const env = {
    CATALOG_R2: {
      async put(key, body) {
        writes.push(key);
        objects.set(key, body);
      },
      async get(key) {
        if (key === 'staging/showcase-cohort.json') return null;
        const body = objects.get(key);
        return body == null ? null : { async text() { return body; } };
      },
    },
  };

  await assert.rejects(
    publishToR2(env, catalog(10), {}),
    /showcase-cohort\.json devolvió null/,
  );
  assert.equal(writes.includes('showcase/v1/cohort.json'), false);
  assert.equal(writes.includes('catalog.json'), false);
  assert.equal(writes.includes('meta.json'), false);
});
