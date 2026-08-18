import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregateDynamicRemarketingUy,
  buildDiagnosis,
  countFeedItems,
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

test('la implementación no contiene llamadas de escritura a Merchant API', () => {
  const source = readFileSync('scripts/commerce/merchant-readonly-audit.mjs', 'utf8');
  assert.doesNotMatch(source, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
  assert.doesNotMatch(source, /productInputs:insert|:fetch|triggeraction/i);
  assert.match(source, /merchantapi\.googleapis\.com/);
  assert.doesNotMatch(source, /\/v1beta\//);
});
