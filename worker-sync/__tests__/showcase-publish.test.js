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

function catalog(count = 3200) {
  return {
    total: count,
    updated_at: '2026-08-20T12:00:00.000Z',
    items: Array.from({ length: count }, (_, index) => item(index)),
  };
}

test('prepara 3000 ediciones v2 y conserva las primeras 1000 como cohorte v1', () => {
  const value = catalog(3200);
  const syncMeta = {};
  const { cohort, legacyCohort, metrics } = prepareShowcaseCatalog(value, syncMeta);

  assert.equal(cohort.schema_version, 2);
  assert.equal(cohort.total, 3000);
  assert.equal(cohort.ids.length, 3000);
  assert.equal(new Set(cohort.ids).size, 3000);
  assert.equal(legacyCohort.schema_version, 1);
  assert.equal(legacyCohort.total, 1000);
  assert.deepEqual(legacyCohort.ids, cohort.ids.slice(0, 1000));
  assert.equal(metrics.selected_items, 3000);
  assert.equal(value.items.filter(entry => entry.showcase_rank).length, 3000);
  assert.equal(value.data_quality.showcase_selection.selected_items, 3000);
  assert.equal(syncMeta.showcase_selection.selected_items, 3000);
  assert.equal(syncMeta.showcase_selection.legacy_selected_items, 1000);
  assert.deepEqual(
    value.items
      .filter(entry => entry.showcase_rank)
      .map(entry => entry.showcase_rank)
      .sort((a, b) => a - b),
    Array.from({ length: 3000 }, (_, index) => index + 1),
  );
});

test('publica métricas de niveles de contenido y limpieza de títulos', () => {
  const rawTitle = 'Manual De Emdr Y Procesos De Terapia Familiar, De Louise Shapiro. Editorial Ediciones Pléyades En Español';
  const value = {
    total: 3,
    updated_at: '2026-08-20T12:00:00.000Z',
    items: [
      item(1, {
        title: rawTitle,
        author: 'Francine Shapiro, Florence W. Kaslow y Louise Maxfield',
        publisher: 'Ediciones Pléyades',
        description: 'a'.repeat(500),
        bibliographic: { language: 'Español', format: 'Tapa blanda' },
      }),
      item(2, { description: 'b'.repeat(120) }),
      item(3, { description: null }),
    ],
  };
  const syncMeta = {};
  const { metrics } = prepareShowcaseCatalog(value, syncMeta);

  assert.equal(metrics.selected_editorial, 1);
  assert.equal(metrics.selected_descriptive, 1);
  assert.equal(metrics.selected_bibliographic, 1);
  assert.equal(metrics.selected_title_cleaned, 1);
  assert.equal(value.items[0].title, rawTitle);
  assert.equal(value.items[0].showcase_display_title, 'Manual de EMDR y Procesos de Terapia Familiar');
  assert.equal(syncMeta.showcase_selection.selected_title_over_70_before, 1);
  assert.equal(syncMeta.showcase_selection.selected_title_over_70_after, 0);
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

  const { cohort, legacyCohort } = prepareShowcaseCatalog(value);
  assert.equal(cohort.ids[0], 'MLU633557235');
  assert.equal(legacyCohort.ids[0], 'MLU633557235');
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

  const { cohort, legacyCohort, metrics } = prepareShowcaseCatalog(value);
  assert.deepEqual(cohort.ids, [representative.id]);
  assert.deepEqual(legacyCohort.ids, [representative.id]);
  assert.equal(metrics.duplicate_editions_excluded, 1);
  assert.equal(paused.showcase_rank, undefined);
  assert.equal(original.showcase_rank, undefined);
});

test('publica staging, valida readback y promueve v1 antes de v2', async () => {
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
  const value = catalog(3005);
  const syncMeta = { status: 'success' };

  await publishToR2(env, value, syncMeta);

  assert.deepEqual(writes.map(write => write.key), [
    'staging/catalog.json',
    'staging/meta.json',
    'staging/showcase-cohort-v1.json',
    'staging/showcase-cohort-v2.json',
    'catalog.json',
    'meta.json',
    'showcase/v1/cohort.json',
    'showcase/v2/cohort.json',
  ]);
  const v1 = JSON.parse(objects.get('showcase/v1/cohort.json'));
  const v2 = JSON.parse(objects.get('showcase/v2/cohort.json'));
  const liveCatalog = JSON.parse(objects.get('catalog.json'));
  assert.equal(v1.total, 1000);
  assert.equal(v2.total, 3000);
  assert.deepEqual(v1.ids, v2.ids.slice(0, 1000));
  assert.equal(liveCatalog.data_quality.showcase_selection.selected_items, 3000);
  assert.equal(syncMeta.showcase_selection.selected_items, 3000);
  assert.equal(writes[6].options.httpMetadata.cacheControl, 'public, max-age=300');
  assert.equal(writes[7].options.httpMetadata.cacheControl, 'public, max-age=300');
});

test('si el readback de cualquiera de las cohortes falla no toca archivos live', async () => {
  for (const missingKey of [
    'staging/showcase-cohort-v1.json',
    'staging/showcase-cohort-v2.json',
  ]) {
    const objects = new Map();
    const writes = [];
    const env = {
      CATALOG_R2: {
        async put(key, body) {
          writes.push(key);
          objects.set(key, body);
        },
        async get(key) {
          if (key === missingKey) return null;
          const body = objects.get(key);
          return body == null ? null : { async text() { return body; } };
        },
      },
    };

    await assert.rejects(
      publishToR2(env, catalog(10), {}),
      /Readback de cohortes vidriera devolvió null/,
    );
    assert.equal(writes.includes('showcase/v1/cohort.json'), false);
    assert.equal(writes.includes('showcase/v2/cohort.json'), false);
    assert.equal(writes.includes('catalog.json'), false);
    assert.equal(writes.includes('meta.json'), false);
  }
});
