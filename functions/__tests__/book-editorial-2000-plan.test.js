import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertEditorialBatchPlan,
  buildEditorialBatchPlan,
  selectEditorialBatch,
  titleFingerprint,
  validateEditorialOutputTitleLock,
} from '../../scripts/seo/book-editorial-2000-plan.mjs';

function isbnFor(index) {
  const base = `978${String(index).padStart(9, '0')}`;
  const sum = [...base].reduce(
    (total, digit, position) => total + Number(digit) * (position % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base}${(10 - (sum % 10)) % 10}`;
}

function item(index, overrides = {}) {
  return {
    id: `MLU${1000000000 + index}`,
    isbn: isbnFor(index),
    title: `Título comercial exacto ${index}`,
    author: 'Autora Real',
    publisher: 'Editorial Real',
    pages: 240,
    description: '',
    status: 'active',
    available_quantity: 1,
    price: 1490,
    currency_id: 'UYU',
    condition: 'new',
    domain_id: 'MLU-BOOKS',
    ...overrides,
  };
}

function factualRecord(index) {
  return {
    schema_version: 1,
    isbn: isbnFor(index),
    decision: 'auto_publish_facts',
    facts: { publisher: 'Editorial Real' },
  };
}

function editorialRecord(index) {
  return {
    schema_version: 1,
    isbn: isbnFor(index),
    decision: 'auto_publish',
    editorial: {
      paragraphs: [
        'Primer párrafo editorial suficientemente desarrollado para describir de forma concreta el contenido de la obra y su propuesta para el lector, sin alterar ningún dato comercial de la publicación.',
        'Segundo párrafo editorial suficientemente desarrollado para explicar temas, estructura, enfoque, responsables y utilidad de la obra con información verificable y específica.',
      ],
      highlights: [
        'Característica específica y comprobada número uno.',
        'Característica específica y comprobada número dos.',
        'Característica específica y comprobada número tres.',
        'Característica específica y comprobada número cuatro.',
        'Característica específica y comprobada número cinco.',
      ],
      decision_copy: 'Recomendación suficientemente específica para ayudar a decidir a qué lector puede servirle la obra, qué necesidad cubre y en qué casos conviene comparar otra edición antes de comprar.',
      meta_description: 'Descripción editorial útil y específica para buscadores y lectores, sin modificar el título comercial original.',
      merchant_description: 'Descripción editorial específica y suficientemente extensa para Google Merchant, construida con contenido comprobado de la obra y datos de edición verificables, sin reemplazar el título comercial ni alterar precio, stock, imágenes o canonical.',
    },
  };
}

test('selecciona 2.000 ISBN y prioriza convertir fichas meramente bibliográficas', () => {
  const catalogItems = Array.from({ length: 2005 }, (_, index) => item(index + 1));
  const enrichmentRecords = [
    factualRecord(2005),
    editorialRecord(2004),
  ];

  const result = selectEditorialBatch({
    catalogItems,
    enrichmentRecords,
    limit: 2000,
  });

  assert.equal(result.selected.length, 2000);
  assert.equal(result.selected[0].isbn, isbnFor(2005));
  assert.equal(result.selected.some(entry => entry.isbn === isbnFor(2004)), false);
  assert.equal(result.excluded.already_editorial_real, 1);
});

test('un mismo ISBN puede conservar dos títulos distintos sin excluirse ni normalizarse', () => {
  const isbn = isbnFor(3000);
  const result = selectEditorialBatch({
    catalogItems: [
      item(3000, { isbn, title: 'Título comercial A' }),
      item(3001, { isbn, title: 'Título comercial B' }),
      item(3002),
    ],
    enrichmentRecords: [],
    limit: 2,
  });

  const group = result.selected.find(entry => entry.isbn === isbn);
  assert.ok(group);
  assert.equal(group.title_variant_count, 2);
  assert.deepEqual(
    group.title_snapshots.map(snapshot => snapshot.title).sort(),
    ['Título comercial A', 'Título comercial B'],
  );
  assert.equal(group.title_snapshots[0].sha256, titleFingerprint(group.title_snapshots[0].title));
  assert.equal(group.title_snapshots[1].sha256, titleFingerprint(group.title_snapshots[1].title));
});

test('el plan conserva por MLU título, H1, HTML, Merchant, slug y canonical', () => {
  const catalogItems = Array.from({ length: 2000 }, (_, index) => item(index + 1));
  const plan = buildEditorialBatchPlan({
    catalogItems,
    enrichmentRecords: [],
    limit: 2000,
    generatedAt: '2026-08-31T12:00:00.000Z',
  });

  assert.equal(assertEditorialBatchPlan(plan, 2000), true);
  assert.equal(plan.selected_count, 2000);
  assert.equal(plan.title_policy.commercial_title, 'immutable_byte_for_byte_per_listing');
  assert.equal(plan.title_policy.editorial_payload_title_fields, 'forbidden');
  assert.equal(plan.title_policy.h1, 'from_current_listing_title');
  assert.equal(plan.title_policy.html_title, 'from_current_listing_title');
  assert.equal(plan.title_policy.merchant_title, 'from_current_listing_title');
  const snapshot = plan.entries[0].title_snapshots[0];
  assert.equal(snapshot.sha256, titleFingerprint(snapshot.title));
});

test('acepta contenido editorial cuando no intenta definir ningún título', () => {
  const plan = buildEditorialBatchPlan({
    catalogItems: [item(1)],
    enrichmentRecords: [],
    limit: 1,
    generatedAt: '2026-08-31T12:00:00.000Z',
  });
  const record = {
    isbn: plan.entries[0].isbn,
    editorial: {
      heading: 'Qué contiene esta edición',
      paragraphs: ['Contenido editorial real y específico.'],
      meta_description: 'Descripción específica.',
    },
  };

  assert.deepEqual(validateEditorialOutputTitleLock(plan, [record]), []);
});

test('bloquea title, seo_title y cualquier otro campo comercial dentro de la salida', () => {
  const plan = buildEditorialBatchPlan({
    catalogItems: [item(1)],
    enrichmentRecords: [],
    limit: 1,
    generatedAt: '2026-08-31T12:00:00.000Z',
  });
  const errors = validateEditorialOutputTitleLock(plan, [{
    isbn: plan.entries[0].isbn,
    title: 'Título cambiado',
    canonical: '/otra-url',
    editorial: {
      seo_title: 'Título SEO cambiado',
    },
  }]);

  assert.ok(errors.some(error => error.includes('campo comercial prohibido: title')));
  assert.ok(errors.some(error => error.includes('campo comercial prohibido: canonical')));
  assert.ok(errors.some(error => error.includes('campo comercial prohibido: editorial.seo_title')));
});
