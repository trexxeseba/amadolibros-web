import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregateDynamicRemarketingUy,
  buildDiagnosis,
  buildReconciliationDiagnosis,
  countFeedItems,
  endpointError,
  listAll,
  OFFER_CSV_COLUMNS,
  parseFeedOffers,
  reconcileOffers,
  reconciliationMarkdown,
  requestJson,
  rowsToCsv,
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

function buildDataSources() {
  return [
    {
      name: 'accounts/533/dataSources/1',
      input: 'AUTOFEED',
      displayName: 'Autofeed sitio',
      primaryProductDataSource: {},
    },
    {
      name: 'accounts/533/dataSources/2',
      input: 'FILE',
      displayName: 'Feed subido',
      primaryProductDataSource: {},
    },
    {
      name: 'accounts/533/dataSources/3',
      input: 'API',
      displayName: 'Carga externa',
      supplementalProductDataSource: {},
    },
  ].map(summarizeDataSource);
}

// Fixtures reproducen la forma real de Merchant API v1: los atributos
// procesados de cada producto viajan bajo `productAttributes` (no bajo
// `attributes`, que fue el bug que infló missingPrice/missingImage a
// "todo el catálogo" en la corrida real del workflow 32643394006).
function buildReconciliationProducts() {
  return [
    {
      // libro-1 aparece en dos productos distintos (distinto feedLabel),
      // uno resuelto a AUTOFEED y otro a FILE: señal de solapamiento.
      name: 'accounts/533/products/1',
      offerId: 'libro-1',
      channel: 'ONLINE',
      feedLabel: 'AR',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/1',
      productAttributes: { price: { amountMicros: '500000000', currencyCode: 'UYU' }, imageLink: 'https://example.com/1.jpg' },
    },
    {
      name: 'accounts/533/products/2',
      offerId: 'libro-1',
      channel: 'ONLINE',
      feedLabel: 'UY',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/2',
      productAttributes: { price: { amountMicros: '500000000', currencyCode: 'UYU' }, imageLink: 'https://example.com/1.jpg' },
    },
    {
      // libro-2: sin productAttributes.price -> precio ausente.
      name: 'accounts/533/products/3',
      offerId: 'libro-2',
      channel: 'ONLINE',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/1',
      productAttributes: { imageLink: 'https://example.com/2.jpg' },
    },
    {
      // libro-3: sin productAttributes.imageLink -> imagen ausente.
      name: 'accounts/533/products/4',
      offerId: 'libro-3',
      channel: 'ONLINE',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/2',
      productAttributes: { price: { amountMicros: '300000000', currencyCode: 'UYU' } },
    },
    {
      // libro-4: fuente API (no AUTOFEED/FILE), precio e imagen completos -> caso "ok" de control.
      name: 'accounts/533/products/5',
      offerId: 'libro-4',
      channel: 'ONLINE',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/3',
      productAttributes: { price: { amountMicros: '100000000', currencyCode: 'UYU' }, imageLink: 'https://example.com/4.jpg' },
    },
    {
      // sin offerId -> queda fuera de la reconciliación por offer_id.
      name: 'accounts/533/products/6',
      channel: 'ONLINE',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/1',
      productAttributes: { price: { amountMicros: '100000000', currencyCode: 'UYU' }, imageLink: 'https://example.com/6.jpg' },
    },
    {
      // libro-5: monto presente pero sin moneda -> precio no utilizable.
      name: 'accounts/533/products/7',
      offerId: 'libro-5',
      channel: 'ONLINE',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/1',
      productAttributes: { price: { amountMicros: '250000000' }, imageLink: 'https://example.com/5.jpg' },
    },
    {
      // libro-6: imagen presente pero con issue DISAPPROVED -> imagen bloqueada.
      name: 'accounts/533/products/8',
      offerId: 'libro-6',
      channel: 'ONLINE',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/1',
      productAttributes: { price: { amountMicros: '200000000', currencyCode: 'UYU' }, imageLink: 'https://example.com/6b.jpg' },
      productStatus: {
        itemLevelIssues: [{ code: 'image_too_small', severity: 'DISAPPROVED', attribute: 'image_link' }],
      },
    },
    {
      // libro-7: imagen presente con advertencia NOT_IMPACTED -> no es ausente ni bloqueada.
      name: 'accounts/533/products/9',
      offerId: 'libro-7',
      channel: 'ONLINE',
      contentLanguage: 'es',
      dataSource: 'accounts/533/dataSources/1',
      productAttributes: { price: { amountMicros: '150000000', currencyCode: 'UYU' }, imageLink: 'https://example.com/7.jpg' },
      productStatus: {
        itemLevelIssues: [{ code: 'image_low_resolution', severity: 'NOT_IMPACTED', attribute: 'image_link' }],
      },
    },
  ];
}

test('lee precio e imagen desde productAttributes (la forma real de Merchant API v1, no attributes)', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const libro4 = result.rows.find(row => row.offerId === 'libro-4');
  assert.equal(libro4.hasPrice, true);
  assert.equal(libro4.hasImage, true);
  assert.equal(libro4.imageStatus, 'ok');
});

test('detecta una señal de posible solapamiento AUTOFEED/FILE sin certificarla como confirmada', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  assert.equal(result.overlapSignals.length, 1);
  assert.equal(result.overlapSignals[0].offerId, 'libro-1');
  const inputs = result.overlapSignals[0].entries.map(entry => entry.sourceInput).sort();
  assert.deepEqual(inputs, ['AUTOFEED', 'FILE']);
  const feedLabels = result.overlapSignals[0].entries.map(entry => entry.feedLabel).sort();
  assert.deepEqual(feedLabels, ['AR', 'UY']);
});

test('no marca como señal de solapamiento ofertas distintas o de una sola fuente', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const signalOfferIds = new Set(result.overlapSignals.map(overlap => overlap.offerId));
  for (const offerId of ['libro-2', 'libro-3', 'libro-4', 'libro-5', 'libro-6', 'libro-7']) {
    assert.equal(signalOfferIds.has(offerId), false);
  }
});

test('detecta precio ausente por offer_id, incluyendo monto sin moneda', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const offerIds = result.missingPrice.map(row => row.offerId).sort();
  assert.deepEqual(offerIds, ['libro-2', 'libro-5']);
});

test('separa imagen ausente, bloqueada y advertencia (no bloqueante) por offer_id', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const missingOfferIds = result.missingImage.map(row => row.offerId).sort();
  assert.deepEqual(missingOfferIds, ['libro-3', 'libro-6']);

  const ausente = result.missingImage.find(row => row.offerId === 'libro-3');
  assert.equal(ausente.imageStatus, 'ausente');
  assert.deepEqual(ausente.imageBlockingIssueCodes, []);

  const bloqueada = result.missingImage.find(row => row.offerId === 'libro-6');
  assert.equal(bloqueada.imageStatus, 'bloqueada');
  assert.deepEqual(bloqueada.imageBlockingIssueCodes, ['image_too_small']);

  assert.equal(result.imageWarnings.length, 1);
  assert.equal(result.imageWarnings[0].offerId, 'libro-7');
  assert.equal(result.imageWarnings[0].imageStatus, 'advertencia');
  assert.deepEqual(result.imageWarnings[0].imageWarningIssueCodes, ['image_low_resolution']);
  assert.equal(missingOfferIds.includes('libro-7'), false);
});

test('identifica de forma consistente la fuente y su tipo por producto', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const byOffer = Object.fromEntries(result.rows.map(row => [`${row.offerId}:${row.dataSource}`, row]));
  const autofeedRow = byOffer['libro-1:accounts/533/dataSources/1'];
  assert.equal(autofeedRow.sourceInput, 'AUTOFEED');
  assert.equal(autofeedRow.sourceType, 'primaryProductDataSource');
  assert.equal(autofeedRow.dataSourceDisplayName, 'Autofeed sitio');
  assert.equal(result.missingOfferId, 1);
});

test('los resultados de reconciliación no están hardcodeados a los snapshots históricos 47/18', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  assert.notEqual(result.missingPrice.length, 47);
  assert.notEqual(result.missingImage.length, 18);
  assert.equal(result.missingPrice.length, 2);
  assert.equal(result.missingImage.length, 2);
});

test('las filas de los CSV coinciden con los conteos del JSON y los subconjuntos no superan el total', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const totalCsv = rowsToCsv(OFFER_CSV_COLUMNS, result.rows);
  const totalDataRows = totalCsv.trim().split('\n').length - 1;
  assert.equal(totalDataRows, result.rows.length);

  const missingPriceCsv = rowsToCsv(OFFER_CSV_COLUMNS, result.missingPrice);
  assert.equal(missingPriceCsv.trim().split('\n').length - 1, result.missingPrice.length);

  const missingImageCsv = rowsToCsv(OFFER_CSV_COLUMNS, result.missingImage);
  assert.equal(missingImageCsv.trim().split('\n').length - 1, result.missingImage.length);

  assert.ok(result.missingPrice.length <= result.rows.length);
  assert.ok(result.missingImage.length <= result.rows.length);
  assert.ok(result.uniqueOffers <= result.rows.length);
});

test('parsea offer_id, precio e imagen desde el feed público sin depender de la API', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><g:id>libro-1</g:id><g:price>500.00 UYU</g:price><g:image_link><![CDATA[https://example.com/1.jpg]]></g:image_link></item>
    <item><g:id>libro-9</g:id></item>
  </channel></rss>`;
  const offers = parseFeedOffers(xml);
  assert.equal(offers.length, 2);
  assert.equal(offers[0].offerId, 'libro-1');
  assert.equal(offers[0].hasPrice, true);
  assert.equal(offers[0].hasImage, true);
  assert.equal(offers[1].offerId, 'libro-9');
  assert.equal(offers[1].hasPrice, false);
  assert.equal(offers[1].hasImage, false);
});

test('listAll pagina usando nextPageToken hasta agotarlo y no filtra el token de acceso en la URL', async () => {
  const originalFetch = global.fetch;
  const calledUrls = [];
  global.fetch = async url => {
    calledUrls.push(String(url));
    const parsed = new URL(String(url));
    const pageToken = parsed.searchParams.get('pageToken');
    const body = pageToken === 'page-2'
      ? { products: [{ offerId: 'libro-b' }] }
      : { products: [{ offerId: 'libro-a' }], nextPageToken: 'page-2' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const rows = await listAll({
      endpoint: 'https://merchantapi.googleapis.com/products/v1/accounts/533/products',
      arrayField: 'products',
      pageSize: 1,
      accessToken: 'super-secret-token',
    });
    assert.deepEqual(rows.map(row => row.offerId), ['libro-a', 'libro-b']);
    assert.equal(calledUrls.length, 2);
    assert.ok(calledUrls.every(url => !url.includes('super-secret-token')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('los errores de la API se sanitizan y no exponen el token de acceso', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(
    JSON.stringify({
      error: {
        message: 'PERMISSION_DENIED en la cuenta',
        status: 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'IAM_PERMISSION_DENIED' }],
      },
    }),
    { status: 403 },
  );
  try {
    await assert.rejects(
      () => requestJson(new URL('https://merchantapi.googleapis.com/products/v1/accounts/533/products'), 'super-secret-token'),
      error => {
        const normalized = endpointError(error);
        const serialized = JSON.stringify(normalized);
        assert.equal(serialized.includes('super-secret-token'), false);
        assert.equal(normalized.httpStatus, 403);
        assert.equal(normalized.apiStatus, 'PERMISSION_DENIED');
        return true;
      },
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('el CSV protege contra formula injection en offer_id y evidencia', () => {
  const csv = rowsToCsv(
    [['offer_id', 'offerId'], ['evidence', 'evidence']],
    [{ offerId: '=cmd|" /C calc"!A0', evidence: '+SUM(A1:A2)' }, { offerId: '-1+1', evidence: '@HYPERLINK("evil")' }],
  );
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], '"offer_id","evidence"');
  assert.ok(lines[1].startsWith('"\'=cmd'));
  assert.ok(lines[1].includes('"\'+SUM'));
  assert.ok(lines[2].startsWith('"\'-1+1"'));
  assert.ok(lines[2].includes('"\'@HYPERLINK'));
});

test('el diagnóstico de reconciliación separa hechos, hipótesis y limitaciones sin hardcodear snapshots', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const diagnosis = buildReconciliationDiagnosis(result);
  assert.ok(diagnosis.facts.some(fact => fact.includes('Se detectaron 1 offer_id')));
  assert.ok(diagnosis.hypotheses.some(hypothesis => hypothesis.text.includes('revisión manual')));
  assert.ok(Array.isArray(diagnosis.limitations) && diagnosis.limitations.length > 0);
  assert.ok(diagnosis.limitations.some(text => text.includes('productInputs')));
});

test('el reporte de reconciliación nunca describe el solapamiento como "confirmado"', () => {
  const result = reconcileOffers(buildReconciliationProducts(), buildDataSources(), []);
  const diagnosis = buildReconciliationDiagnosis(result);
  const combinedText = JSON.stringify({ diagnosis, overlapSignals: result.overlapSignals });
  assert.equal(/solapamiento\s+confirmado/i.test(combinedText), false);
});

test('el resumen Markdown reporta el solapamiento como señal a investigar, no como confirmado', () => {
  const dataSources = buildDataSources();
  const result = reconcileOffers(buildReconciliationProducts(), dataSources, []);
  const diagnosis = buildReconciliationDiagnosis(result);
  const report = {
    generatedAt: '2026-08-23T00:00:00.000Z',
    accountId: '5330457716',
    sourcesObserved: result.offersBySource.map(row => row.input),
    uniqueOffers: result.uniqueOffers,
    offersBySource: result.offersBySource,
    overlapSignalCount: result.overlapSignals.length,
    overlapSignals: result.overlapSignals,
    missingPriceCount: result.missingPrice.length,
    missingImageCount: result.missingImage.length,
    imageWarningCount: result.imageWarnings.length,
    feedOfferCount: result.feedOfferCount,
    historicalSnapshots: {
      missingPrice: 47,
      missingImage: 18,
      overlapSuspected: 'posible solapamiento AUTOFEED/FILE (referencia histórica, no confirmada previamente)',
    },
    diagnosis,
  };
  const markdown = reconciliationMarkdown(report);
  assert.equal(/solapamiento\s+AUTOFEED\s*\/\s*FILE\s+confirmado/i.test(markdown), false);
  assert.match(markdown, /señal de posible solapamiento/i);
  assert.match(markdown, /no confirmada/i);
});

test('la implementación no contiene llamadas de escritura a Merchant API', () => {
  const source = readFileSync('scripts/commerce/merchant-readonly-audit.mjs', 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
  assert.doesNotMatch(source, /productInputs:insert|:fetch|triggeraction/i);
  assert.match(source, /merchantapi\.googleapis\.com/);
  assert.doesNotMatch(source, /\/v1beta\//);
});
