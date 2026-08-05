import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { assertDate, buildRequest, normalizeReport, toCsv } = require('../../scripts/ga4-export.js');

test('valida fechas reales en formato ISO', () => {
  assert.doesNotThrow(() => assertDate('2026-07-31', 'fecha'));
  assert.throws(() => assertDate('31/07/2026', 'fecha'), /YYYY-MM-DD/);
  assert.throws(() => assertDate('2026-02-30', 'fecha'), /fecha válida/);
});

test('construye el request sin credenciales y conserva el filtro orgánico', () => {
  const request = buildRequest(
    {
      dimensions: ['deviceCategory'],
      metrics: ['sessions'],
      filter: { filter: { fieldName: 'sessionDefaultChannelGroup' } },
    },
    '2026-07-01',
    '2026-07-31',
  );
  assert.deepEqual(request.dateRanges, [
    { startDate: '2026-07-01', endDate: '2026-07-31' },
  ]);
  assert.deepEqual(request.dimensions, [{ name: 'deviceCategory' }]);
  assert.deepEqual(request.metrics, [{ name: 'sessions' }]);
  assert.equal(request.dimensionFilter.filter.fieldName, 'sessionDefaultChannelGroup');
  assert.equal(JSON.stringify(request).includes('token'), false);
});

test('normaliza la respuesta exacta de GA4 y genera CSV seguro', () => {
  const normalized = normalizeReport(
    { id: 'example' },
    {
      dimensionHeaders: [{ name: 'landingPage' }],
      metricHeaders: [{ name: 'sessions', type: 'TYPE_INTEGER' }],
      rows: [
        {
          dimensionValues: [{ value: '=malicious' }],
          metricValues: [{ value: '17' }],
        },
      ],
      rowCount: 1,
    },
    {
      property: 'properties/123',
      startDate: '2026-07-01',
      endDate: '2026-07-31',
      extractedAt: '2026-08-04T00:00:00.000Z',
    },
  );
  assert.equal(normalized.rows[0].metrics.sessions, '17');
  assert.match(toCsv(normalized), /"'=malicious","17"/);
});
