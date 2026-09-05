import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  accountIssueLogSummary,
  aggregateDynamicRemarketingUy,
  aggregateProductStatusesByContextUy,
  buildDataSourceInputMap,
  buildDiagnosis,
  compareOfferIdsAcrossInputs,
  countByInput,
  countFeedItems,
  crossReferenceOfferIds,
  finalizeContextSummary,
  joinDataSourceProductCounts,
  listProductsByIssueCode,
  productDestinationStatus,
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

// BLOQUEANTE PR #312 (misma auditoría, mismo PR) — detalle producto por
// producto de los bloqueos prioritarios (image_too_small, precio faltante,
// ebooks, landing pages) y cruce real de offer_id entre AUTOFEED y FILE.
// Todo puro post-procesamiento en memoria sobre products.list ya leído.

function sampleProduct(overrides = {}) {
  return {
    offerId: 'AL-0001',
    dataSource: 'accounts/533/dataSources/1',
    productAttributes: {
      title: 'Cien años de soledad',
      link: 'https://www.amadolibros.com/producto/cien-anos-de-soledad?utm_source=x',
      imageLink: 'https://cdn.amadolibros.com/img/cien-anos.jpg?token=secreto',
      price: { amountMicros: '450000000', currencyCode: 'UYU' },
      availability: 'in stock',
    },
    productStatus: {
      destinationStatuses: [
        { reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['UY'] },
        { reportingContext: 'FREE_LISTINGS', approvedCountries: ['UY'] },
      ],
      itemLevelIssues: [
        { code: 'image_too_small', severity: 'DISAPPROVED', reportingContext: 'SHOPPING_ADS' },
      ],
    },
    ...overrides,
  };
}

test('lista producto por producto los que tienen un código de issue dado, de-duplicados por offer_id', () => {
  const products = [
    sampleProduct(),
    sampleProduct({
      offerId: 'AL-0002',
      productAttributes: { ...sampleProduct().productAttributes, title: 'Rayuela', price: undefined },
      productStatus: {
        destinationStatuses: [{ reportingContext: 'FREE_LISTINGS', pendingCountries: ['UY'] }],
        itemLevelIssues: [{ code: 'item_missing_required_attribute', attribute: 'price', reportingContext: 'FREE_LISTINGS' }],
      },
    }),
    sampleProduct({ offerId: 'AL-0003', productStatus: { itemLevelIssues: [{ code: 'ebooks_policy_violation', reportingContext: 'SHOPPING_ADS' }] } }),
  ];

  const tooSmall = listProductsByIssueCode(products, { code: 'image_too_small', contexts: ['SHOPPING_ADS', 'FREE_LISTINGS'] });
  assert.equal(tooSmall.length, 1);
  assert.equal(tooSmall[0].offerId, 'AL-0001');
  assert.equal(tooSmall[0].title, 'Cien años de soledad');
  assert.equal(tooSmall[0].price, '450.00 UYU');
  assert.equal(tooSmall[0].shoppingAdsStatus, 'disapproved');
  assert.equal(tooSmall[0].freeListingsStatus, 'active');
  // ni la URL ni la imagen exponen credenciales o tokens de query.
  assert.equal(JSON.stringify(tooSmall).includes('secreto'), false);
  assert.equal(JSON.stringify(tooSmall).includes('utm_source'), false);

  const missingPrice = listProductsByIssueCode(products, { code: 'item_missing_required_attribute', attribute: 'price', contexts: ['SHOPPING_ADS', 'FREE_LISTINGS'] });
  assert.equal(missingPrice.length, 1);
  assert.equal(missingPrice[0].offerId, 'AL-0002');
  assert.equal(missingPrice[0].price, null);

  const ebooks = listProductsByIssueCode(products, { code: 'ebooks_policy_violation', contexts: ['SHOPPING_ADS'] });
  assert.equal(ebooks.length, 1);
  assert.equal(ebooks[0].offerId, 'AL-0003');
});

test('el mismo offer_id con dos issues distintos no se cuenta dos veces dentro de una misma lista', () => {
  const product = sampleProduct({
    productStatus: {
      destinationStatuses: [],
      itemLevelIssues: [
        { code: 'image_too_small', reportingContext: 'SHOPPING_ADS' },
        { code: 'image_too_small', reportingContext: 'FREE_LISTINGS' },
      ],
    },
  });
  const result = listProductsByIssueCode([product, product], { code: 'image_too_small', contexts: ['SHOPPING_ADS', 'FREE_LISTINGS'] });
  assert.equal(result.length, 1);
});

test('cruza offer_id exactos entre dos listas de issues (no sólo cantidades)', () => {
  const a = [{ offerId: 'AL-1' }, { offerId: 'AL-2' }, { offerId: 'AL-3' }];
  const b = [{ offerId: 'AL-2' }, { offerId: 'AL-4' }];
  const overlap = crossReferenceOfferIds(a, b);
  assert.deepEqual(overlap, { both: 1, onlyA: 2, onlyB: 1 });
});

test('countByInput agrupa filas por el input real de su dataSource', () => {
  const map = buildDataSourceInputMap([
    { name: 'accounts/533/dataSources/1', input: 'AUTOFEED' },
    { name: 'accounts/533/dataSources/2', input: 'FILE' },
  ]);
  const rows = [
    { dataSource: 'accounts/533/dataSources/1' },
    { dataSource: 'accounts/533/dataSources/1' },
    { dataSource: 'accounts/533/dataSources/2' },
    { dataSource: 'accounts/533/dataSources/9' },
  ];
  assert.deepEqual(countByInput(rows, map), { AUTOFEED: 2, FILE: 1, '(desconocido)': 1 });
});

test('compara offer_id reales entre AUTOFEED y FILE, no sólo el total por fuente', () => {
  const map = buildDataSourceInputMap([
    { name: 'accounts/533/dataSources/autofeed', input: 'AUTOFEED' },
    { name: 'accounts/533/dataSources/file', input: 'FILE' },
  ]);
  const products = [
    sampleProduct({ offerId: 'AL-DUP', dataSource: 'accounts/533/dataSources/autofeed', productAttributes: { title: 'Duplicado (autofeed)', price: { amountMicros: '400000000', currencyCode: 'UYU' } } }),
    sampleProduct({ offerId: 'AL-DUP', dataSource: 'accounts/533/dataSources/file', productAttributes: { title: 'Duplicado (file)', price: { amountMicros: '420000000', currencyCode: 'UYU' } } }),
    sampleProduct({ offerId: 'AL-SOLO-AUTOFEED', dataSource: 'accounts/533/dataSources/autofeed' }),
    sampleProduct({ offerId: 'AL-SOLO-FILE', dataSource: 'accounts/533/dataSources/file' }),
  ];

  const result = compareOfferIdsAcrossInputs(products, map, ['AUTOFEED', 'FILE'], 10);
  assert.equal(result.totalUniqueOfferIds, 3);
  assert.equal(result.bothCount, 1);
  assert.equal(result.onlyACount, 1);
  assert.equal(result.onlyBCount, 1);
  assert.equal(result.sampleBoth.length, 1);
  assert.equal(result.sampleBoth[0].offerId, 'AL-DUP');
  assert.equal(result.sampleBoth[0].AUTOFEED.title, 'Duplicado (autofeed)');
  assert.equal(result.sampleBoth[0].FILE.title, 'Duplicado (file)');
  assert.equal(result.sampleBoth[0].AUTOFEED.price, '400.00 UYU');
  assert.equal(result.sampleBoth[0].FILE.price, '420.00 UYU');
});

test('productDestinationStatus devuelve el estado real por reportingContext, no el de Dynamic remarketing', () => {
  const product = sampleProduct();
  assert.equal(productDestinationStatus(product, 'SHOPPING_ADS'), 'disapproved');
  assert.equal(productDestinationStatus(product, 'FREE_LISTINGS'), 'active');
  assert.equal(productDestinationStatus(product, 'DISPLAY_ADS'), 'missing_context');
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
