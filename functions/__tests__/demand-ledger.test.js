// DEMAND-LEDGER-1 — el ledger convierte los exports de GSC ya existentes en
// un artefacto versionado de oportunidad por URL. Estos tests cubren las seis
// garantías pedidas explícitamente: exclusión de marca, curva CTR por
// posición, productos pausados, productos sin GSC, datos inválidos y
// reproducibilidad — más la clasificación de página y el contrato del
// artefacto generado.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCtrCurve,
  buildDemandLedger,
  classifyPage,
  expectedCtrForPosition,
  isBrandQuery,
  ledgerModuleSource,
  productIdFromPage,
  scoreRow,
} from '../../scripts/seo/generate-demand-ledger.mjs';

function pageRow(url, { impressions = 0, clicks = 0, ctr, position = 5 } = {}) {
  return {
    keys: [url],
    impressions,
    clicks,
    ctr: ctr ?? (impressions > 0 ? clicks / impressions : 0),
    position,
  };
}

function pageQueryRow(url, query, { impressions = 0, clicks = 0, position = 5 } = {}) {
  return {
    keys: [url, query],
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position,
  };
}

const CATALOG_URL = 'https://www.amadolibros.com/catalogo';
const FICHA_URL = 'https://www.amadolibros.com/libro/MLU1000000001/un-libro-de-prueba';
const HUB_URL = 'https://www.amadolibros.com/libros/esoterismo-tarot';

// ── 1. Exclusión de marca ────────────────────────────────────────────────

test('isBrandQuery reconoce marca y variantes, no falsos positivos', () => {
  assert.equal(isBrandQuery('amado libros'), true);
  assert.equal(isBrandQuery('Amado Libros Uruguay'), true);
  assert.equal(isBrandQuery('amadolibros'), true);
  assert.equal(isBrandQuery('amado-libros'), true);
  assert.equal(isBrandQuery('amado libros libreria en linea'), true);
  assert.equal(isBrandQuery('libros montessori uruguay'), false);
  assert.equal(isBrandQuery('el amado de mi vida'), false); // "amado" solo no es marca
  assert.equal(isBrandQuery(''), false);
  assert.equal(isBrandQuery(null), false);
});

test('una URL cuya demanda es 100% de marca queda brand_excluded, sin score y fuera de la curva', () => {
  const { rows, meta } = buildDemandLedger({
    pageRows: [pageRow('https://www.amadolibros.com/', { impressions: 600, clicks: 130, position: 9.8 })],
    pageQueryRows: [
      pageQueryRow('https://www.amadolibros.com/', 'amado libros', { impressions: 400, clicks: 100 }),
      pageQueryRow('https://www.amadolibros.com/', 'amadolibros uruguay', { impressions: 200, clicks: 30 }),
    ],
    catalogItems: [],
    categoryIndex: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].brand_excluded, true);
  assert.equal(rows[0].opportunity_score, null);
  assert.match(rows[0].score_reason, /^marca:/);
  assert.equal(rows[0].expected_ctr, null);
  assert.equal(meta.brand_excluded_rows, 1);
  assert.equal(meta.ctr_curve_sample_impressions, 0, 'la página 100% marca no debe entrar a la curva');
});

test('una URL con marca Y queries reales sólo excluye la marca, no la página entera', () => {
  const { rows } = buildDemandLedger({
    pageRows: [pageRow(HUB_URL, { impressions: 500, clicks: 20, position: 8 })],
    pageQueryRows: [
      pageQueryRow(HUB_URL, 'amado libros tarot', { impressions: 100, clicks: 15 }),
      pageQueryRow(HUB_URL, 'tarot uruguay', { impressions: 400, clicks: 5 }),
    ],
    catalogItems: [],
    categoryIndex: {},
  });
  assert.equal(rows[0].brand_excluded, false);
  assert.equal(rows[0].top_query, 'tarot uruguay');
});

test('sin datos de query para una URL, no se asume marca', () => {
  const { rows } = buildDemandLedger({
    pageRows: [pageRow(CATALOG_URL, { impressions: 887, clicks: 13, position: 16.9 })],
    pageQueryRows: [],
    catalogItems: [],
    categoryIndex: {},
  });
  assert.equal(rows[0].brand_excluded, false);
  assert.equal(rows[0].top_query, null);
});

// ── 2. Curva de CTR por posición ─────────────────────────────────────────

test('buildCtrCurve calcula CTR real por posición, no un benchmark fijo', () => {
  const rows = [
    { impressions: 100, clicks: 30, position: 1 },
    { impressions: 100, clicks: 5, position: 10 },
  ];
  const result = buildCtrCurve(rows, { minBucketImpressions: 50 });
  assert.equal(result.curve[1], 0.3);
  assert.equal(result.curve[10], 0.05);
  assert.equal(result.sampleImpressions, 200);
});

test('buildCtrCurve ensancha la ventana cuando un bucket no tiene muestra suficiente', () => {
  const rows = [
    { impressions: 10, clicks: 2, position: 7 }, // insuficiente solo
    { impressions: 100, clicks: 10, position: 8 },
    { impressions: 100, clicks: 10, position: 6 },
  ];
  const result = buildCtrCurve(rows, { minBucketImpressions: 50 });
  // el bucket 7 debe absorber vecinos hasta juntar >=50 impresiones
  const combinedImpr = 10 + 100 + 100;
  const combinedClicks = 2 + 10 + 10;
  assert.equal(result.curve[7], combinedClicks / combinedImpr);
});

test('buildCtrCurve cae al promedio global cuando no hay ninguna muestra en absoluto', () => {
  const result = buildCtrCurve([], { minBucketImpressions: 50 });
  assert.equal(result.sampleImpressions, 0);
  assert.equal(result.globalCtr, 0);
  for (let pos = 1; pos <= 20; pos++) assert.equal(result.curve[pos], 0);
});

test('expectedCtrForPosition redondea a la posición entera más cercana y respeta el cap en 20', () => {
  const result = buildCtrCurve([{ impressions: 1000, clicks: 100, position: 20 }], { minBucketImpressions: 10 });
  assert.equal(expectedCtrForPosition(result, 20.5), result.curve[20]);
  assert.equal(expectedCtrForPosition(result, 45), result.curve[20]); // más allá del cap -> bucket 20
  assert.equal(expectedCtrForPosition(result, 0), null);
  assert.equal(expectedCtrForPosition(result, -1), null);
  assert.equal(expectedCtrForPosition(null, 5), null);
});

test('expectedCtrForPosition devuelve null cuando la curva no tiene ninguna muestra', () => {
  const result = buildCtrCurve([]);
  assert.equal(expectedCtrForPosition(result, 5), null);
});

test('scoreRow: gap positivo produce score > 0 con motivo explicando el cálculo', () => {
  const { score, reason } = scoreRow(
    { impressions: 100, ctr: 0.02, position: 8, productStatus: 'active', stock: 3, brandExcluded: false },
    0.05,
  );
  assert.equal(score, Math.round((0.05 - 0.02) * 100 * 1 * 100) / 100);
  assert.match(reason, /CTR observado/);
  assert.match(reason, /impresiones\/28d/);
});

test('scoreRow: CTR ya por encima del esperado da score 0, no negativo', () => {
  const { score, reason } = scoreRow(
    { impressions: 100, ctr: 0.4, position: 3, productStatus: 'active', stock: 1, brandExcluded: false },
    0.1,
  );
  assert.equal(score, 0);
  assert.match(reason, /ya iguala o supera/);
});

// ── 3. Productos pausados ────────────────────────────────────────────────

test('una ficha cuyo MLU está en el catálogo como pausado recibe product_status paused y menor peso de score', () => {
  const { rows } = buildDemandLedger({
    pageRows: [pageRow(FICHA_URL, { impressions: 100, clicks: 1, position: 6 })],
    pageQueryRows: [pageQueryRow(FICHA_URL, 'un libro de prueba', { impressions: 100, clicks: 1, position: 6 })],
    catalogItems: [{ id: 'MLU1000000001', status: 'paused', available_quantity: 0, isbn: '9780000000002' }],
    categoryIndex: {},
    minBucketImpressions: 10,
  });
  assert.equal(rows[0].product_status, 'paused');
  assert.equal(rows[0].stock, 0);
  assert.equal(rows[0].isbn, '9780000000002');
});

// ── 4. Productos sin GSC ─────────────────────────────────────────────────

test('un producto activo del catálogo que nunca aparece en GSC no genera ninguna fila fantasma', () => {
  const { rows } = buildDemandLedger({
    pageRows: [pageRow(CATALOG_URL, { impressions: 10, clicks: 1, position: 5 })],
    pageQueryRows: [],
    catalogItems: [
      { id: 'MLU1000000001', status: 'active', available_quantity: 5, isbn: '9780000000002' },
      { id: 'MLU1000000002', status: 'active', available_quantity: 2, isbn: '9780000000002' },
    ],
    categoryIndex: {},
  });
  assert.equal(rows.length, 1, 'el ledger sólo tiene filas por URL vista en GSC, nunca una por producto');
  assert.equal(rows.some(r => r.product_id === 'MLU1000000001'), false);
});

// ── 5. Datos inválidos ───────────────────────────────────────────────────

test('filas de GSC malformadas se descartan sin romper el cálculo', () => {
  const { rows } = buildDemandLedger({
    pageRows: [
      { keys: [], impressions: 5, clicks: 1, position: 3 }, // sin URL
      { keys: [FICHA_URL], impressions: 'no-numero', clicks: null, position: undefined },
      pageRow(CATALOG_URL, { impressions: 20, clicks: 2, position: 4 }),
    ],
    pageQueryRows: [
      { keys: [FICHA_URL], impressions: 5 }, // falta la query
      { keys: [null, 'tarot'], impressions: 5, clicks: 1 }, // page inválida
    ],
    catalogItems: [null, {}, { id: 'MLU1', status: 'active', available_quantity: 1 }],
    categoryIndex: {},
  });
  // La fila sin keys se descarta; la fila con impressions no numéricas se
  // conserva pero normalizada a 0 (no explota); el catálogo con basura no
  // rompe la construcción del índice.
  const urls = rows.map(r => r.url);
  assert.ok(urls.includes(FICHA_URL));
  assert.ok(urls.includes(CATALOG_URL));
  assert.equal(rows.find(r => r.url === FICHA_URL).impressions, 0);
});

test('buildDemandLedger valida tipos de entrada y falla explícito, no en silencio', () => {
  assert.throws(() => buildDemandLedger({ pageRows: 'no-array' }), /pageRows debe ser un array/);
  assert.throws(() => buildDemandLedger({ pageQueryRows: 'no-array' }), /pageQueryRows debe ser un array/);
  assert.throws(() => buildDemandLedger({ catalogItems: 'no-array' }), /catalogItems debe ser un array/);
  assert.throws(() => buildDemandLedger({ categoryIndex: null }), /categoryIndex debe ser un objeto/);
});

// ── 6. Reproducibilidad ──────────────────────────────────────────────────

test('mismo input produce exactamente el mismo output (determinismo)', () => {
  const input = {
    pageRows: [
      pageRow(CATALOG_URL, { impressions: 887, clicks: 13, position: 16.9 }),
      pageRow(FICHA_URL, { impressions: 350, clicks: 9, position: 9.1 }),
      pageRow('https://www.amadolibros.com/', { impressions: 672, clicks: 144, position: 9.9 }),
    ],
    pageQueryRows: [
      pageQueryRow(FICHA_URL, 'murdoku uruguay', { impressions: 244, clicks: 9, position: 9.1 }),
      pageQueryRow('https://www.amadolibros.com/', 'amado libros', { impressions: 500, clicks: 130 }),
    ],
    catalogItems: [{ id: 'MLU1000000001', status: 'active', available_quantity: 4, isbn: '9789871387861' }],
    categoryIndex: { MLU1000000001: ['esoterismo-tarot', 'tarot-oraculos'] },
  };
  const first = buildDemandLedger(input);
  const second = buildDemandLedger(input);
  assert.deepEqual(first, second);

  const firstSource = ledgerModuleSource({ rows: first.rows, metadata: { schema_version: 1, ...first.meta } });
  const secondSource = ledgerModuleSource({ rows: second.rows, metadata: { schema_version: 1, ...second.meta } });
  assert.equal(firstSource, secondSource, 'el módulo generado debe ser byte-idéntico para el mismo input');
});

// ── Clasificación de página ──────────────────────────────────────────────

test('classifyPage identifica fichas, catálogo, hubs de categoría/especialidad/autor, home y otro', () => {
  assert.deepEqual(classifyPage(FICHA_URL), { pageType: 'ficha', productId: 'MLU1000000001', categorySlug: null });
  assert.deepEqual(classifyPage(CATALOG_URL), { pageType: 'catalogo', productId: null, categorySlug: null });
  assert.deepEqual(classifyPage(HUB_URL), { pageType: 'categoria_hub', productId: null, categorySlug: 'esoterismo-tarot' });
  assert.deepEqual(
    classifyPage('https://www.amadolibros.com/especialidades/medicina'),
    { pageType: 'especialidad_hub', productId: null, categorySlug: 'medicina' },
  );
  assert.deepEqual(
    classifyPage('https://www.amadolibros.com/libros-maria-montessori-uruguay'),
    { pageType: 'autor_hub', productId: null, categorySlug: 'maria-montessori' },
  );
  assert.deepEqual(classifyPage('https://www.amadolibros.com/'), { pageType: 'home', productId: null, categorySlug: null });
  assert.deepEqual(classifyPage('https://www.amadolibros.com/politicas'), { pageType: 'otro', productId: null, categorySlug: null });
  assert.deepEqual(classifyPage('no-es-una-url'), { pageType: 'otro', productId: null, categorySlug: null });
});

test('productIdFromPage extrae el MLU sólo de rutas de ficha', () => {
  assert.equal(productIdFromPage(FICHA_URL), 'MLU1000000001');
  assert.equal(productIdFromPage(CATALOG_URL), null);
  assert.equal(productIdFromPage(''), null);
});

// ── Categoría/subcategoría e ISBN normalizado ────────────────────────────

test('una ficha con categoría/subcategoría mapeada las expone; una sin mapa queda null', () => {
  const { rows } = buildDemandLedger({
    pageRows: [pageRow(FICHA_URL, { impressions: 100, clicks: 5, position: 5 })],
    pageQueryRows: [],
    catalogItems: [{ id: 'MLU1000000001', status: 'active', available_quantity: 1, isbn: '9789871387861' }],
    categoryIndex: { MLU1000000001: ['esoterismo-tarot', 'tarot-oraculos'] },
  });
  assert.equal(rows[0].category_id, 'esoterismo-tarot');
  assert.equal(rows[0].subcategory_id, 'tarot-oraculos');
  assert.equal(rows[0].isbn, '9789871387861');
});

test('un hub de categoría usa el propio slug de la URL como category_id', () => {
  const { rows } = buildDemandLedger({
    pageRows: [pageRow(HUB_URL, { impressions: 200, clicks: 5, position: 10 })],
    pageQueryRows: [],
    catalogItems: [],
    categoryIndex: {},
  });
  assert.equal(rows[0].category_id, 'esoterismo-tarot');
  assert.equal(rows[0].page_type, 'categoria_hub');
});

// ── Orden y contrato del artefacto generado ──────────────────────────────

test('las filas quedan ordenadas por score desc, luego impresiones desc, luego url', () => {
  const { rows } = buildDemandLedger({
    pageRows: [
      pageRow('https://www.amadolibros.com/libro/MLU2/b', { impressions: 100, clicks: 1, position: 8 }), // gap grande
      pageRow('https://www.amadolibros.com/libro/MLU3/c', { impressions: 50, clicks: 20, position: 8 }), // gap chico/0
      pageRow('https://www.amadolibros.com/libro/MLU1/a', { impressions: 5, clicks: 0, position: 8 }), // sin score (pocas impresiones)
    ],
    pageQueryRows: [],
    catalogItems: [],
    categoryIndex: {},
    minBucketImpressions: 10,
  });
  const scores = rows.map(r => r.opportunity_score);
  assert.deepEqual(scores.filter(s => s != null), [...scores.filter(s => s != null)].sort((a, b) => b - a));
  assert.equal(rows.at(-1).opportunity_score, null, 'la fila sin score confiable queda al final');
});

test('ledgerModuleSource produce un módulo válido con los lookups de conveniencia', async () => {
  const { rows, meta } = buildDemandLedger({
    pageRows: [pageRow(FICHA_URL, { impressions: 100, clicks: 1, position: 8 })],
    pageQueryRows: [],
    catalogItems: [],
    categoryIndex: {},
    minBucketImpressions: 10,
  });
  const source = ledgerModuleSource({ rows, metadata: { schema_version: 1, generated_at: '2026-01-01T00:00:00.000Z', ...meta } });
  assert.match(source, /^\/\/ Archivo generado por scripts\/seo\/generate-demand-ledger\.mjs\./);
  assert.match(source, /export const DEMAND_LEDGER_META = Object\.freeze/);
  assert.match(source, /export const DEMAND_LEDGER = Object\.freeze/);
  assert.match(source, /export function opportunityForUrl/);
  assert.match(source, /export function opportunityForProductId/);
  assert.match(source, /export function topOpportunities/);

  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const mod = await import(dataUrl);
  assert.equal(mod.DEMAND_LEDGER.length, 1);
  assert.equal(mod.opportunityForUrl(FICHA_URL).url, FICHA_URL);
  assert.equal(mod.opportunityForProductId('MLU1000000001').product_id, 'MLU1000000001');
  assert.equal(mod.opportunityForUrl('https://no-existe'), null);
  assert.ok(Object.isFrozen(mod.DEMAND_LEDGER));
  assert.ok(Object.isFrozen(mod.DEMAND_LEDGER[0]));
});
