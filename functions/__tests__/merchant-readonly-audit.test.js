import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  aggregateDynamicRemarketingUy,
  buildDiagnosis,
  countFeedItems,
  extractFeedIds,
  listProductsByIssue,
  summarizeAllDestinations,
  summarizeDataSource,
  summarizeProducts,
  summarizeSourceOverlap,
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

test('lista los productos de cada causa, con tope y total real', () => {
  const products = [
    {
      offerId: 'MLU111',
      attributes: { title: 'Libro de duelo', link: 'https://www.amadolibros.com/libro/MLU111/duelo?utm=x' },
      dataSource: 'accounts/533/dataSources/1',
      productStatus: {
        itemLevelIssues: [{
          code: 'personal_hardships_policy_violation',
          reportingContext: 'DISPLAY_ADS',
          applicableCountries: ['UY'],
        }],
      },
    },
    {
      offerId: 'MLU222',
      attributes: { title: 'Otro de duelo', link: 'https://usuario:clave@www.amadolibros.com/libro/MLU222/otro' },
      dataSource: 'accounts/533/dataSources/1',
      productStatus: {
        itemLevelIssues: [{
          code: 'personal_hardships_policy_violation',
          reportingContext: 'DISPLAY_ADS',
          applicableCountries: ['UY'],
        }],
      },
    },
    {
      offerId: 'MLU333',
      attributes: { title: 'Fuera del destino' },
      dataSource: 'accounts/533/dataSources/2',
      productStatus: {
        itemLevelIssues: [{
          code: 'personal_hardships_policy_violation',
          reportingContext: 'SHOPPING_ADS',
          applicableCountries: ['UY'],
        }],
      },
    },
    {
      offerId: 'MLU444',
      attributes: { title: 'Fuera del país' },
      dataSource: 'accounts/533/dataSources/2',
      productStatus: {
        itemLevelIssues: [{
          code: 'ebooks_policy_violation',
          reportingContext: 'DISPLAY_ADS',
          applicableCountries: ['AR'],
        }],
      },
    },
  ];

  const grupos = listProductsByIssue(products, { limitPerIssue: 1 });

  assert.equal(grupos.length, 1, 'sólo la causa que aplica al destino y al país');
  const duelo = grupos[0];
  assert.equal(duelo.code, 'personal_hardships_policy_violation');
  assert.equal(duelo.total, 2, 'el total cuenta todos, no sólo la muestra');
  assert.equal(duelo.sample.length, 1, 'la muestra respeta el tope');
  assert.equal(duelo.sample[0].offerId, 'MLU111');
  assert.equal(duelo.sample[0].link, 'https://www.amadolibros.com/libro/MLU111/duelo');
});

test('el listado por causa nunca imprime credenciales del link', () => {
  const grupos = listProductsByIssue([
    {
      offerId: 'MLU999',
      attributes: { title: 'Con credenciales', link: 'https://usuario:clave@example.com/x?token=secreto' },
      productStatus: {
        itemLevelIssues: [{ code: 'ebooks_policy_violation', reportingContext: 'DISPLAY_ADS' }],
      },
    },
  ]);

  const serializado = JSON.stringify(grupos);
  assert.equal(serializado.includes('clave'), false);
  assert.equal(serializado.includes('secreto'), false);
  assert.equal(serializado.includes('usuario'), false);
});

test('extrae los g:id que viajan en el feed', () => {
  const ids = extractFeedIds('<item><g:id>MLU1</g:id></item><item><g:id> MLU2 </g:id></item><item><g:id></g:id></item>');
  assert.deepEqual([...ids].sort(), ['MLU1', 'MLU2']);
});

test('cruza cada rechazo contra el feed y el catálogo propios', () => {
  const products = [
    {
      offerId: 'MLU_EN_FEED',
      dataSource: 'accounts/533/dataSources/1',
      productStatus: {
        itemLevelIssues: [{ code: 'ebooks_policy_violation', reportingContext: 'DISPLAY_ADS' }],
      },
    },
    {
      offerId: 'MLU_FANTASMA',
      dataSource: 'accounts/533/dataSources/1',
      productStatus: {
        itemLevelIssues: [{ code: 'ebooks_policy_violation', reportingContext: 'DISPLAY_ADS' }],
      },
    },
    {
      offerId: 'MLU_OTRA_CAUSA',
      dataSource: 'accounts/533/dataSources/1',
      productStatus: {
        itemLevelIssues: [{ code: 'illegal_drugs_policy_violation', reportingContext: 'DISPLAY_ADS' }],
      },
    },
  ];

  const [grupo, ...resto] = listProductsByIssue(products, {
    codes: ['ebooks_policy_violation'],
    feedIds: new Set(['MLU_EN_FEED']),
    catalog: new Map([['MLU_EN_FEED', { title: 'Un libro de papel', status: 'active' }]]),
  });

  assert.equal(resto.length, 0, 'el filtro por código deja fuera las demás causas');
  assert.equal(grupo.total, 2);
  assert.equal(grupo.sample[0].enNuestroFeed, true);
  assert.equal(grupo.sample[0].title, 'Un libro de papel');
  assert.equal(grupo.sample[0].estadoEnCatalogo, 'active');
  assert.equal(grupo.sample[1].enNuestroFeed, false, 'lo que Merchant conoce y el feed no tiene');
  assert.equal(grupo.sample[1].estadoEnCatalogo, 'no está');
});

test('resume todos los destinos, no sólo remarketing', () => {
  const filas = summarizeAllDestinations([
    { reportingContext: 'SHOPPING_ADS', country: 'UY', stats: { activeCount: 3000, disapprovedCount: 40 } },
    { reportingContext: 'SHOPPING_ADS', country: 'UY', stats: { activeCount: 100, pendingCount: 5 } },
    { reportingContext: 'DISPLAY_ADS', country: 'UY', stats: { activeCount: 3370, disapprovedCount: 321 } },
    { reportingContext: 'FREE_LISTINGS', country: 'AR', stats: { activeCount: 12, expiringCount: 2 } },
  ]);

  assert.equal(filas.length, 3, 'una fila por destino y país, sumando repetidas');
  assert.equal(filas[0].reportingContext, 'DISPLAY_ADS', 'ordena por activos');
  assert.equal(filas[0].disapproved, 321);

  const shopping = filas.find(f => f.reportingContext === 'SHOPPING_ADS');
  assert.equal(shopping.active, 3100, 'suma las dos filas del mismo destino');
  assert.equal(shopping.pending, 5);
  assert.equal(shopping.disapproved, 40);

  const gratuitas = filas.find(f => f.reportingContext === 'FREE_LISTINGS');
  assert.equal(gratuitas.country, 'AR', 'no descarta otros países');
  assert.equal(gratuitas.expiring, 2);
});

// La pregunta que decide si conviene apagar el AUTOFEED: ¿publica lo mismo que
// el feed (duplicados con datos ajenos) o justo lo que el feed excluyó?
test('el solapamiento por fuente separa duplicados de excluidos, y activos de muertos', () => {
  const productos = [
    { offerId: 'MLU_FEED', dataSource: 'src/feed' },
    { offerId: 'MLU_FEED', dataSource: 'src/auto' },          // duplicado: Google lo tiene dos veces
    { offerId: 'MLU_EXCLUIDO_ACTIVO', dataSource: 'src/auto' }, // activo, pero fuera del feed
    { offerId: 'MLU_PAUSADO', dataSource: 'src/auto' },
    { offerId: 'MLU_FANTASMA', dataSource: 'src/auto' },       // Merchant lo conoce, el catálogo ya no
  ];
  const filas = summarizeSourceOverlap(productos, {
    feedIds: new Set(['MLU_FEED']),
    catalog: new Map([
      ['MLU_FEED', { status: 'active' }],
      ['MLU_EXCLUIDO_ACTIVO', { status: 'active' }],
      ['MLU_PAUSADO', { status: 'paused' }],
    ]),
  });

  const auto = filas.find(f => f.dataSource === 'src/auto');
  assert.equal(auto.total, 4);
  assert.equal(auto.enFeed, 1, 'el duplicado cuenta como solapado');
  assert.equal(auto.fueraDelFeed, 3);
  assert.equal(auto.fueraActivos, 1);
  assert.equal(auto.fueraPausados, 1);
  assert.equal(auto.fueraSinCatalogo, 1);

  const feed = filas.find(f => f.dataSource === 'src/feed');
  assert.equal(feed.enFeed, 1);
  assert.equal(feed.fueraDelFeed, 0);
});

test('sin feed ni catálogo el solapamiento no inventa: todo queda como fuera del feed y sin catálogo', () => {
  const [fila] = summarizeSourceOverlap([{ offerId: 'X', dataSource: 's' }]);
  assert.equal(fila.enFeed, 0);
  assert.equal(fila.fueraDelFeed, 1);
  assert.equal(fila.fueraSinCatalogo, 1);
});

// catalog.json trae sólo activos; los pausados viven en otro índice. Un pausado
// no es un fantasma: es inventario por encargo, y hay que contarlo aparte.
test('el índice de pausados separa «por encargo» de «desaparecido»', () => {
  const [fila] = summarizeSourceOverlap(
    [
      { offerId: 'MLU_PAUSADO_EN_INDICE', dataSource: 'auto' },
      { offerId: 'MLU_FANTASMA', dataSource: 'auto' },
    ],
    { feedIds: new Set(), catalog: new Map(), pausedIds: new Set(['MLU_PAUSADO_EN_INDICE']) },
  );
  assert.equal(fila.fueraPausados, 1);
  assert.equal(fila.fueraSinCatalogo, 1);
});
