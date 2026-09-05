import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  accountIssueLogSummary,
  aggregateDynamicRemarketingUy,
  aggregateProductStatusesByContextUy,
  buildDiagnosis,
  countFeedItems,
  finalizeContextSummary,
  joinDataSourceProductCounts,
  summarizeDataSource,
  summarizeProducts,
} from '../../scripts/commerce/merchant-readonly-audit.mjs';

test('cuenta únicamente ofertas item del feed', () => {
  assert.equal(countFeedItems('<rss><channel><item></item><item data-x="1"></item></channel></rss>'), 2);
  assert.equal(countFeedItems('<rss><channel></channel></rss>'), 0);
});

test('resume fuentes sin exponer credenciales o parámetros secretos', () => {
  const row = summarizeDataSource({
    name: 'accounts/533/dataSources/12',
    dataSourceId: '12',
    displayName: 'Feed Amado',
    input: 'FILE',
    primaryProductDataSource: {},
    fileInput: {
      fileInputType: 'FETCH',
      fetchSettings: {
        fetchUri: 'https://usuario:clave@example.com/feed.xml?token=secreto',
        frequency: 'DAILY',
        timeOfDay: { hours: 5, minutes: 0 },
      },
    },
  });

  assert.equal(row.type, 'primaryProductDataSource');
  assert.equal(row.fetchUri, 'https://example.com/feed.xml');
  assert.equal(JSON.stringify(row).includes('clave'), false);
  assert.equal(JSON.stringify(row).includes('secreto'), false);
  assert.equal(JSON.stringify(row).includes('usuario'), false);
});

test('agrega el destino Dynamic remarketing para Uruguay', () => {
  const result = aggregateDynamicRemarketingUy([
    {
      reportingContext: 'DISPLAY_ADS',
      country: 'UY',
      stats: { activeCount: '2981', pendingCount: '14', disapprovedCount: '669', expiringCount: '120' },
      itemLevelIssues: [{ code: 'expiration_date', severity: 'DISAPPROVED', productCount: '120' }],
    },
    {
      reportingContext: 'SHOPPING_ADS',
      country: 'UY',
      stats: { activeCount: '10' },
    },
  ]);

  assert.equal(result.rows, 1);
  assert.equal(result.active, 2981);
  assert.equal(result.pending, 14);
  assert.equal(result.disapproved, 669);
  assert.equal(result.expiring, 120);
  assert.equal(result.issueCounts.get('expiration_date').productCount, 120);
});

test('clasifica productos procesados por estado, fuente y vencimiento', () => {
  const now = new Date('2026-08-18T12:00:00.000Z');
  const products = [
    {
      dataSource: 'accounts/533/dataSources/1',
      productStatus: {
        googleExpirationDate: '2026-08-20T12:00:00.000Z',
        lastUpdateDate: '2026-08-17T01:00:00.000Z',
        destinationStatuses: [{ reportingContext: 'DISPLAY_ADS', approvedCountries: ['UY'] }],
        itemLevelIssues: [],
      },
    },
    {
      dataSource: 'accounts/533/dataSources/2',
      productStatus: {
        googleExpirationDate: '2026-08-28T12:00:00.000Z',
        lastUpdateDate: '2026-08-16T01:00:00.000Z',
        destinationStatuses: [{ reportingContext: 'DISPLAY_ADS', disapprovedCountries: ['UY'] }],
        itemLevelIssues: [{
          code: 'image_too_small',
          severity: 'DISAPPROVED',
          reportingContext: 'DISPLAY_ADS',
          applicableCountries: ['UY'],
        }],
      },
    },
  ];

  const result = summarizeProducts(products, now);
  assert.equal(result.processed, 2);
  assert.equal(result.dynamicRemarketingUy.active, 1);
  assert.equal(result.dynamicRemarketingUy.disapproved, 1);
  assert.equal(result.expiringWithin3Days, 1);
  assert.equal(result.byDataSource.length, 2);
  assert.equal(result.topIssues[0].code, 'image_too_small');
});

test('el diagnóstico diferencia hechos de hipótesis', () => {
  const diagnosis = buildDiagnosis({
    alert: { previousActive: 3745, currentActive: 2981 },
    feedCount: 3664,
    dataSources: [
      { type: 'primaryProductDataSource' },
      { type: 'primaryProductDataSource' },
    ],
    accountIssues: [],
    aggregate: { active: 2981, pending: 0, disapproved: 683, expiring: 100 },
    products: { processed: 3664, dynamicRemarketingUy: { active: 2981 }, expiringWithin3Days: 100 },
  });

  assert.ok(diagnosis.facts.some(row => row.includes('3745')));
  assert.ok(diagnosis.hypotheses.some(row => row.text.includes('683 ofertas')));
  assert.ok(diagnosis.hypotheses.some(row => row.text.includes('2 fuentes primarias')));
});

// BLOQUEANTE PR #311 — Merchant Center (Gran Apuesta): el diagnóstico
// original filtraba deliberadamente a un solo reportingContext (Dynamic
// remarketing / DISPLAY_ADS), así que nunca mostraba Shopping ads, Free
// listings ni ningún otro destino que la cuenta pudiera tener. Estas
// pruebas cubren la ampliación: agrupar TODOS los reportingContext reales
// de Uruguay sin descartar ninguno, cruzar dataSources con su conteo real
// de productos, y resumir accountIssues sin PII.

test('agrupa TODOS los reportingContext de Uruguay, sin descartar ninguno', () => {
  const byContext = aggregateProductStatusesByContextUy([
    {
      reportingContext: 'DISPLAY_ADS',
      country: 'UY',
      stats: { activeCount: '3381', pendingCount: '0', disapprovedCount: '318' },
      itemLevelIssues: [{ code: 'personal_hardships_policy_violation', severity: 'DISAPPROVED', productCount: '239' }],
    },
    {
      reportingContext: 'SHOPPING_ADS',
      country: 'UY',
      stats: { activeCount: '500', pendingCount: '10', disapprovedCount: '5' },
      itemLevelIssues: [{ code: 'missing_gtin', severity: 'DEMOTED', productCount: '12' }],
    },
    {
      reportingContext: 'FREE_LISTINGS',
      country: 'UY',
      stats: { activeCount: '200' },
    },
    {
      // Otro país: no debe mezclarse con Uruguay.
      reportingContext: 'DISPLAY_ADS',
      country: 'AR',
      stats: { activeCount: '999' },
    },
  ]);

  assert.equal(byContext.size, 3);
  assert.ok(byContext.has('DISPLAY_ADS'));
  assert.ok(byContext.has('SHOPPING_ADS'));
  assert.ok(byContext.has('FREE_LISTINGS'));

  const display = byContext.get('DISPLAY_ADS');
  assert.equal(display.active, 3381);
  assert.equal(display.disapproved, 318);
  assert.equal(display.issueCounts.get('personal_hardships_policy_violation').productCount, 239);

  const shopping = byContext.get('SHOPPING_ADS');
  assert.equal(shopping.active, 500);
  assert.equal(shopping.pending, 10);
  assert.equal(shopping.issueCounts.get('missing_gtin').productCount, 12);

  const free = byContext.get('FREE_LISTINGS');
  assert.equal(free.active, 200);
  assert.equal(free.pending, 0);
});

test('un reportingContext desconocido/nuevo también se agrupa (no hay lista cerrada de contextos)', () => {
  const byContext = aggregateProductStatusesByContextUy([
    { reportingContext: 'LOCAL_INVENTORY_ADS', country: 'UY', stats: { activeCount: '3' } },
  ]);
  assert.equal(byContext.size, 1);
  assert.equal(byContext.get('LOCAL_INVENTORY_ADS').active, 3);
});

test('finalizeContextSummary ordena por productCount y respeta el límite (top N)', () => {
  const summary = {
    reportingContext: 'SHOPPING_ADS',
    rows: 1,
    active: 10,
    pending: 0,
    disapproved: 3,
    expiring: 0,
    issueCounts: new Map([
      ['a_code', { code: 'a_code', severity: 'DISAPPROVED', productCount: 1 }],
      ['b_code', { code: 'b_code', severity: 'DISAPPROVED', productCount: 5 }],
      ['c_code', { code: 'c_code', severity: 'DISAPPROVED', productCount: 3 }],
    ]),
  };
  const finalized = finalizeContextSummary(summary, 2);
  assert.equal(finalized.reportingContext, 'SHOPPING_ADS');
  assert.equal(finalized.topIssues.length, 2);
  assert.deepEqual(finalized.topIssues.map(row => row.code), ['b_code', 'c_code']);
});

test('cruza dataSources con el conteo real de productos por fuente', () => {
  const dataSources = [
    { name: 'accounts/533/dataSources/1', displayName: 'Feed Amado', type: 'primaryProductDataSource' },
    { name: 'accounts/533/dataSources/2', displayName: 'Suplementaria', type: 'supplementalProductDataSource' },
  ];
  const byDataSource = [{ dataSource: 'accounts/533/dataSources/1', count: 6974 }];
  const joined = joinDataSourceProductCounts(dataSources, byDataSource);
  assert.equal(joined[0].productCount, 6974);
  assert.equal(joined[1].productCount, 0);
  assert.equal(joined[0].displayName, 'Feed Amado');
});

test('el resumen de accountIssues no expone PII y lista los destinos afectados sin duplicar', () => {
  const summary = accountIssueLogSummary({
    title: 'Cuenta pendiente de verificación',
    severity: 'CRITICAL',
    impactedDestinations: [
      { reportingContext: 'SHOPPING_ADS', impacts: [] },
      { reportingContext: 'SHOPPING_ADS', impacts: [] },
      { reportingContext: 'FREE_LISTINGS', impacts: [] },
    ],
  });
  assert.equal(summary.title, 'Cuenta pendiente de verificación');
  assert.equal(summary.severity, 'CRITICAL');
  assert.deepEqual(summary.destinations, ['SHOPPING_ADS', 'FREE_LISTINGS']);
  assert.doesNotMatch(JSON.stringify(summary), /@|telefono|phone|email/i);
});

test('la implementación no contiene llamadas de escritura a Merchant API', () => {
  const source = readFileSync('scripts/commerce/merchant-readonly-audit.mjs', 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
  assert.doesNotMatch(source, /productInputs:insert|:fetch|triggeraction/i);
  assert.match(source, /merchantapi\.googleapis\.com/);
  assert.doesNotMatch(source, /\/v1beta\//);

  // La ampliación del diagnóstico (reportingContexts, dataSources con
  // conteo, accountIssues) es puro post-procesamiento en memoria de datos
  // ya leídos — no agrega ninguna llamada de red nueva. Sólo dos fetch()
  // deben existir en todo el archivo: el de listAll() (endpoints Merchant,
  // todos GET) y el del feed público.
  const fetchCalls = source.match(/\bfetch\(/g) || [];
  assert.equal(fetchCalls.length, 2);
});
