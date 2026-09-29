import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReport,
  missingFields,
  pendingReason,
  renderCsv,
  renderSummary,
  sourceStatus,
} from '../../scripts/seo/fichas-pendientes-report.mjs';

function activeItem(overrides = {}) {
  return {
    id: 'MLU100',
    title: 'Libro de prueba',
    status: 'active',
    available_quantity: 3,
    price: 900,
    currency: 'UYU',
    category_id: 'MLU1196',
    domain_id: 'MLU-BOOKS',
    ...overrides,
  };
}

test('missingFields lista los seis datos básicos que faltan', () => {
  assert.deepEqual(missingFields({ author: 'Desconocido' }), ['author', 'publisher', 'pages', 'year', 'language', 'subjects']);
  assert.deepEqual(missingFields({
    author: 'Erich Fromm', publisher: 'Paidós', pages: 160,
    bibliographic: { publication_year: '2019', language: 'Castellano', subjects: ['Amor'] },
  }), []);
});

test('el estado por fuente distingue pendiente, error, sin datos y encontrado', () => {
  const entries = {
    '9788449331817': {
      google_books: { fetched_at: '2026-09-06T00:00:00Z', error: 'HTTP 429', records: [] },
      open_library: { fetched_at: '2026-09-06T00:00:00Z', error: null, records: [{}] },
      bne: { fetched_at: '2026-09-06T00:00:00Z', error: null, records: [] },
    },
  };
  assert.deepEqual(sourceStatus(entries, '9788449331817'), {
    google_books: 'error', open_library: 'encontrado', bne: 'sin_datos', loc: 'pendiente', dnb: 'pendiente',
  });
});

test('el motivo principal pide una acción distinta en cada caso', () => {
  const all = value => ({ google_books: value, open_library: value, bne: value, loc: value, dnb: value });
  assert.equal(pendingReason({ isbn: 'x', missing: [], sources: all('pendiente') }), 'completa');
  assert.equal(pendingReason({ isbn: '', missing: ['pages'], sources: all('pendiente') }), 'sin_isbn_valido');
  assert.equal(pendingReason({ isbn: 'x', missing: ['pages'], sources: all('pendiente') }), 'falta_google_books');
  assert.equal(pendingReason({ isbn: 'x', missing: ['pages'], sources: { ...all('sin_datos'), loc: 'error' } }), 'falta_otra_fuente');
  assert.equal(pendingReason({ isbn: 'x', missing: ['pages'], sources: all('sin_datos') }), 'ninguna_fuente_lo_conoce');
  assert.equal(pendingReason({ isbn: 'x', missing: ['pages'], sources: { ...all('sin_datos'), bne: 'encontrado' } }), 'evidencia_insuficiente');
  assert.equal(pendingReason({ isbn: 'x', enriched: true, missing: ['pages'], sources: { ...all('sin_datos'), bne: 'encontrado' } }), 'enriquecida_incompleta');
});

test('el informe sólo mira fichas activas vendibles y prioriza las más pobres con stock', () => {
  const rows = buildReport({
    catalogItems: [
      activeItem({ id: 'MLU1', isbn: '9788449331817', available_quantity: 1 }),
      activeItem({ id: 'MLU2', available_quantity: 20 }),
      activeItem({ id: 'MLU3', status: 'paused' }),
    ],
    categoryItems: { MLU1: [['psicologia']], MLU2: [['otros-libros']] },
  });
  assert.deepEqual(rows.map(row => row.id), ['MLU2', 'MLU1']);
  assert.equal(rows[0].reason, 'sin_isbn_valido');
  assert.equal(rows[0].uncategorized, true);
  assert.equal(rows[1].reason, 'falta_google_books');

  const summary = renderSummary(rows, { generatedAt: 'hoy', catalogUpdatedAt: 'ayer' });
  assert.match(summary, /Fichas activas vendibles \| \*\*2\*\*/);
  assert.match(summary, /ISBN que todavía esperan Google Books: \*\*1\*\*/);
  const csv = renderCsv(rows).trim().split('\n');
  assert.equal(csv.length, 3);
  assert.match(csv[1], /^1,MLU2,/);
});
