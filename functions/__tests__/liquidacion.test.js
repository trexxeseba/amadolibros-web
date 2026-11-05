import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    selectLiquidation, sortLiquidation, recentSales, LIQUIDACION,
    liquidationList, selectFromList, resolveLiquidation, liquidationIds,
} from '../_shared/liquidacion.js';
import LIQUIDACION_DATA from '../_shared/liquidacion-data.js';
import { buildExclusions, renderModule, medicalIds, recentIds } from '../../scripts/liquidacion/actualizar-exclusiones.mjs';
import { onRequest as liquidacionPage } from '../liquidacion.js';
import { FOOTER_LINKS } from '../_shared/brand.js';
import { renderFeedItem } from '../feed.xml.js';
import { liquidationTopics, liquidationWhatsAppMessage } from '../liquidacion.js';
import { SITE_HEADER_NAV } from '../_shared/site-header.js';
import { STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';

const NOW = Date.parse('2026-11-04T12:00:00-03:00');
const DAY = 86400000;
const iso = days => new Date(NOW - days * DAY).toISOString();

function book(id, extra = {}) {
    return {
        id, title: `Libro ${id}`, author: 'Autora', price: 1200, currency: 'UYU',
        status: 'active', available_quantity: 1, start_time: iso(500), isbn: null,
        permalink: `https://articulo.mercadolibre.com.uy/${id}`, ...extra,
    };
}

test('entra lo que lleva más de un año publicado, con stock y sin ventas', () => {
    const items = [
        book('MLU1'),
        book('MLU2', { start_time: iso(200) }),            // nuevo
        book('MLU3', { available_quantity: 0 }),            // sin stock
        book('MLU4', { status: 'paused' }),                 // pausado
        book('MLU5', { price: 0 }),                         // sin precio
        book('MLU6', { start_time: null }),                 // sin fecha
        book('MLU7'),                                       // vendido por id
        book('MLU8', { isbn: '9788433920447' }),            // vendido por ISBN en otra publicación
    ];
    const sold = { ids: new Set(['MLU7']), isbns: new Set(['9788433920447']) };
    assert.deepEqual(selectLiquidation(items, sold, NOW).map(i => i.id), ['MLU1']);
});

test('falla cerrada: sin datos de ventas, la regla anterior no selecciona nada', () => {
    const items = [book('MLU1'), book('MLU7'), book('MLU2', { start_time: iso(30) })];
    assert.deepEqual(selectLiquidation(items, null, NOW), []);
});

test('la selección no toca precios', () => {
    const item = book('MLU1', { price: 1990, original_price: 2340 });
    const [out] = selectLiquidation([item], { ids: new Set(), isbns: new Set() }, NOW);
    assert.equal(out.price, 1990);
    assert.equal(out.original_price, 2340);
});

test('orden: mejor presentación primero, después lo más antiguo', () => {
    const items = [
        book('MLU1', { showcase_score: 10, start_time: iso(400) }),
        book('MLU2', { showcase_score: 50, start_time: iso(400) }),
        book('MLU3', { showcase_score: 10, start_time: iso(900) }),
    ];
    assert.deepEqual(sortLiquidation(items, NOW).map(i => i.id), ['MLU2', 'MLU3', 'MLU1']);
});

test('ventas: sin base devuelve null; con base consulta 12 meses y normaliza ISBN', async () => {
    assert.equal(await recentSales({ env: {} }, NOW), null);
    let bound;
    const db = {
        prepare: sql => ({
            bind: since => {
                bound = since;
                assert.match(sql, /ml_sales_items/);
                return { all: async () => ({ results: [
                    { item_id: 'MLU7', isbn: '978-84-339-2044-7' },
                    { item_id: 'MLU9', isbn: null },
                ] }) };
            },
        }),
    };
    const sold = await recentSales({ env: { ORDERS_DB: db } }, NOW);
    assert.equal(bound, NOW - LIQUIDACION.noSalesDays * DAY);
    assert.ok(sold.ids.has('MLU7') && sold.ids.has('MLU9'));
    assert.ok(sold.isbns.has('9788433920447'));
});

test('ventas: si D1 falla, no rompe', async () => {
    const db = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('d1 caído'); } }) }) };
    assert.equal(await recentSales({ env: { ORDERS_DB: db } }, NOW), null);
});

test('feed: custom_label_0=liquidacion solo en los libros seleccionados', () => {
    const item = book('MLU1', { isbn: '9788433920447', pictures: ['https://http2.mlstatic.com/D_1-O.jpg'] });
    const tagged = renderFeedItem(item, null, null, false, new Set(['MLU1']));
    const plain = renderFeedItem(item, null, null, false, new Set(['MLU2']));
    const legacy = renderFeedItem(item);
    assert.match(tagged, /<g:custom_label_0>liquidacion<\/g:custom_label_0>/);
    assert.doesNotMatch(plain, /custom_label_0/);
    assert.doesNotMatch(legacy, /custom_label_0/);
});

test('temas: agrupa por la primera categoría y ordena por cantidad', () => {
    const data = {
        categories: [{ id: 'psicologia', name: 'Psicología' }, { id: 'historia', name: 'Historia' }],
        items: { MLU1: [['psicologia', 'x']], MLU2: [['psicologia']], MLU3: ['historia'], MLU4: [['otra']] },
    };
    const topics = liquidationTopics([book('MLU1'), book('MLU2'), book('MLU3'), book('MLU4')], data);
    assert.deepEqual(topics.map(t => [t.id, t.count]), [['psicologia', 2], ['historia', 1]]);
});

test('WhatsApp: mensaje con motivo, título, precio y página', () => {
    const msg = liquidationWhatsAppMessage(book('MLU1', { price: 1500 }), '/libro/MLU1/libro-mlu1');
    assert.match(msg, /Motivo: Promo Liquidación Amado/);
    assert.match(msg, /Libro: Libro MLU1/);
    assert.match(msg, /Precio publicado: \$1\.500 UYU/);
    assert.match(msg, /Página: https:\/\/www\.amadolibros\.com\/libro\/MLU1\/libro-mlu1/);
});

test('la liquidación está en el menú (SSR y Astro) y en el sitemap', () => {
    assert.ok(SITE_HEADER_NAV.some(i => i.href === '/liquidacion' && i.label === 'Liquidación'));
    const astroHeader = readFileSync('astro-front/src/components/Header.astro', 'utf8');
    assert.match(astroHeader, /href: '\/liquidacion'/);
    assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/liquidacion'));
});

test('copy sin fórmulas restrictivas', () => {
    const page = readFileSync('functions/liquidacion.js', 'utf8');
    assert.doesNotMatch(page, /[úu]nicamente|sólo|solo con/i);
});

// ── Modo lista: data/liquidacion.json ─────────────────────────────────────

const TOPICS = {
    categories: [{ id: 'psicologia', name: 'Psicología' }, { id: 'medicina-salud', name: 'Medicina y salud' }],
    items: {
        MLU1: [['psicologia']], MLU2: [['medicina-salud', 'enfermeria']], MLU3: [['psicologia']],
        MLU4: [['psicologia']], MLU5: [['psicologia']], MLU6: [['psicologia']], MLU8: [['historia'], ['medicina-salud']],
    },
};

function listData(ids, { gana = [], sin = [], medicos = ['MLU2', 'MLU8'], recientes = [] } = {}) {
    return {
        lista: { ids },
        excluir: {
            medicos: { ids: medicos }, recientes: { ids: recientes },
            gana_precio: { ids: gana }, sin_competencia: { ids: sin },
        },
    };
}

test('lista: sin ids entregados, no hay lista (sigue la regla anterior)', () => {
    assert.equal(liquidationList({ lista: { ids: [] } }), null);
    assert.equal(liquidationList({}), null);
    assert.equal(liquidationList({ lista: { ids: ['basura', ''] } }), null);
    // El archivo versionado ya trae la lista: se arma con el workflow "Liquidación, armar la lista".
    const real = liquidationList(LIQUIDACION_DATA);
    assert.ok(real === null || real.ids.size > 0);
});

test('lista: entra solo lo listado, con stock, menos médicos, recientes, gana precio y sin competencia', () => {
    const items = [
        book('MLU1'),                                  // entra
        book('MLU2'),                                  // médico
        book('MLU3'),                                  // publicado hace menos de 90 días
        book('MLU4'),                                  // gana precio
        book('MLU5'),                                  // sin competencia
        book('MLU6', { available_quantity: 0 }),       // sin stock
        book('MLU7'),                                  // no está en la lista
        book('MLU8'),                                  // médico como segundo tema
    ];
    const list = liquidationList(listData(['MLU1', 'MLU2', 'mlu3', 'MLU4', 'MLU5', 'MLU6', 'MLU8', 'MLU99'], { gana: ['MLU4'], sin: ['MLU5'], recientes: ['MLU3'] }));
    const { selected, excluded } = selectFromList(items, list);
    assert.deepEqual(selected.map(i => i.id), ['MLU1']);
    assert.deepEqual(excluded, { fuera_de_stock: 2, medicos: 2, recientes: 1, gana_precio: 1, sin_competencia: 1 });
});

test('recientes (script): exactamente 90 días entra; 89 días o sin fecha quedan afuera', () => {
    const catalog = [
        book('MLU1', { start_time: iso(90) }), book('MLU3', { start_time: null }),
        book('MLU4', { start_time: iso(89) }), book('MLU5', { start_time: iso(400) }),
    ];
    assert.deepEqual(recentIds(['MLU1', 'MLU3', 'MLU4', 'MLU5', 'MLU9'], catalog, NOW), ['MLU3', 'MLU4']);
});

test('la selección es determinista: el índice del cobro (sin fecha ni temas) decide lo mismo que la página', () => {
    const list = liquidationList(listData(['MLU1', 'MLU2', 'MLU3'], { recientes: ['MLU3'] }));
    const page = [book('MLU1'), book('MLU2'), book('MLU3')];
    const checkoutIndex = page.map(({ id, title, price, available_quantity }) => ({ id, title, price, available_quantity, status: 'active' }));
    assert.deepEqual(selectFromList(page, list).selected.map(i => i.id), ['MLU1']);
    assert.deepEqual(selectFromList(checkoutIndex, list).selected.map(i => i.id), ['MLU1']);
});

test('resolveLiquidation: con lista no consulta D1', async () => {
    const db = { prepare: () => { throw new Error('no debería consultar D1'); } };
    const r = await resolveLiquidation({ env: { ORDERS_DB: db } }, [book('MLU1')], { now: NOW, data: listData(['MLU1']) });
    assert.equal(r.mode, 'lista');
    assert.equal(r.sales, 'no-aplica');
    assert.deepEqual(r.selected.map(i => i.id), ['MLU1']);
});

test('resolveLiquidation: sin lista y con D1 caído, vitrina vacía y ventas sin-datos', async () => {
    const db = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('d1 caído'); } }) }) };
    const items = Array.from({ length: 50 }, (_, i) => book(`MLU${i + 1}`));
    const r = await resolveLiquidation({ env: { ORDERS_DB: db } }, items, { now: NOW, data: listData([]) });
    assert.equal(r.mode, 'regla');
    assert.equal(r.sales, 'sin-datos');
    assert.deepEqual(r.selected, []);
});

test('feed: la etiqueta usa solo la lista del JSON, nunca la regla de 1 año', () => {
    const items = [book('MLU1'), book('MLU2'), book('MLU3', { start_time: iso(900) })];
    assert.equal(liquidationIds(items, { data: listData([]) }).size, 0);
    assert.equal(liquidationIds(items).size, 0, 'el archivo versionado todavía no trae lista');
    assert.deepEqual([...liquidationIds(items, { data: listData(['MLU1', 'MLU2']) })], ['MLU1']);
});

test('el feed arma la etiqueta desde la lista, sin la regla de ventas', () => {
    const feed = readFileSync('functions/feed.xml.js', 'utf8');
    assert.match(feed, /liquidationIds\(sortedItems, \{ env: context\.env \}\)/);
    assert.doesNotMatch(feed, /recentSales|selectLiquidation/);
});

// ── Página: falla cerrada y headers ──────────────────────────────────────

function pageCtx({ items, db }) {
    globalThis.caches = { default: { match: async () => null, put: async () => {} } };
    const realFetch = globalThis.fetch;
    globalThis.fetch = async url => {
        const u = String(url);
        if (u.includes('active-categories.json')) return new Response(JSON.stringify(TOPICS), { status: 200 });
        if (u.includes('catalog')) return new Response(JSON.stringify({ items }), { status: 200 });
        return realFetch(url);
    };
    return {
        request: new Request('https://www.amadolibros.com/liquidacion'),
        env: { ORDERS_DB: db, CATALOG_JSON_URL: 'https://www.amadolibros.com/catalog.json' },
        waitUntil: () => {},
        restore: () => { globalThis.fetch = realFetch; delete globalThis.caches; },
    };
}

test('página: con la lista cargada muestra solo lo listado, aunque D1 esté caído', async () => {
    const db = { prepare: () => ({ bind: () => ({ all: async () => { throw new Error('d1 caído'); } }) }) };
    // Libros de prueba que no están en la lista: la vitrina no puede mostrarlos.
    const items = Array.from({ length: 30 }, (_, i) => book(`MLU${i + 1}`, { start_time: iso(800) }));
    const ctx = pageCtx({ items, db });
    try {
        const res = await liquidacionPage(ctx);
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('x-liquidacion-total'), '0');
        const hayLista = liquidationList(LIQUIDACION_DATA) !== null;
        assert.equal(res.headers.get('x-liquidacion-fuente'), hayLista ? 'lista' : 'regla');
        // Con lista no se consulta D1; sin lista, falla cerrada y sin caché.
        assert.equal(res.headers.get('x-liquidacion-ventas'), hayLista ? 'no-aplica' : 'sin-datos');
        const html = await res.text();
        assert.doesNotMatch(html, /<article class="rc-card"/);
        assert.match(html, /próxima tanda/);
    } finally {
        ctx.restore();
    }
});

test('"Lo quiero" lleva id MLU, tema y cta_location para whatsapp_click', () => {
    const page = readFileSync('functions/liquidacion.js', 'utf8');
    assert.match(page, /data-cta-location="liquidacion_card" data-mlu="\$\{escapeHtml\(book\.id\)\}"/);
    assert.match(page, /data-topic="\$\{escapeHtml\(topic\)\}"/);
});

test('textos de la página en positivo y sin emojis', () => {
    const page = readFileSync('functions/liquidacion.js', 'utf8');
    assert.doesNotMatch(page, /Últimas unidades|últimas unidades/);
    assert.doesNotMatch(page, /\p{Extended_Pictographic}/u);
    assert.doesNotMatch(page, /inteligencia artificial/i);
});

// ── Menú y home ──────────────────────────────────────────────────────────

test('la home tiene Liquidación en el menú (escritorio y celular), en el pie y una franja', () => {
    const header = readFileSync('astro-front/src/components/HomeV2Header.astro', 'utf8');
    assert.equal((header.match(/href="\/liquidacion">Liquidación</g) || []).length, 2);
    const footer = readFileSync('astro-front/src/components/Footer.astro', 'utf8');
    assert.match(footer, /href="\/liquidacion"/);
    assert.ok(FOOTER_LINKS.some(l => l.href === '/liquidacion'));
    const home = readFileSync('astro-front/src/pages/index.astro', 'utf8');
    assert.match(home, /<HomeV2Hero \/>\s*<HomeV2Liquidacion \/>/);
    const band = readFileSync('astro-front/src/components/HomeV2Liquidacion.astro', 'utf8');
    assert.match(band, /href="\/liquidacion"/);
    assert.doesNotMatch(band, /\d+ ?%/, 'la franja no promete porcentajes');
});

// ── Datos versionados ────────────────────────────────────────────────────

test('data/liquidacion.json y el módulo generado están sincronizados', () => {
    const json = JSON.parse(readFileSync('data/liquidacion.json', 'utf8'));
    assert.deepEqual(LIQUIDACION_DATA, json);
    assert.equal(readFileSync('functions/_shared/liquidacion-data.js', 'utf8'), renderModule(json));
    assert.ok(Array.isArray(json.lista.ids));
    // sin_competencia queda vacía a propósito: las publicaciones fuera del catálogo entran (Seba, 5/11/2026).
    for (const key of ['medicos', 'gana_precio']) {
        assert.ok(json.excluir[key].ids.length > 0, `${key} viene cargado`);
    }
    for (const key of ['medicos', 'recientes', 'gana_precio', 'sin_competencia']) {
        assert.ok(json.excluir[key].ids.every(id => /^MLU\d+$/.test(id)));
    }
});

test('exclusiones desde el motor: gana precio y marcadas de hoy; las fuera del catálogo no se excluyen', () => {
    const tsv = [
        'id\ttitulo\tprecio\tcatalogo\testado\tmotivo\tdias_demanda\taccion',
        'MLU1\tA\t1500\tsi\twinning\t\t\tmantener',
        'MLU2\tB\t1500\tsi\tsharing_first_place\t\t\tmantener',
        'MLU3\tC\t1500\tno\tnot_listed\t\t\tmantener',
        'MLU4\tD\t1500\tsi\tcompeting\t\t\tbajar',
        'MLU5\tE\t1500\tsi\twinning\t\t\tmantener',
        'MLU6\tF\t1500\tno\tnot_listed\t\t\tmantener',
    ].join('\n');
    const filas = [{ id: 'MLU5', marcada: true }, { id: 'MLU6', marcada: false }];
    const estado = { publicaciones: { MLU4: {}, MLU6: {} } };
    const ex = buildExclusions({ tsv, filas, estado });
    assert.deepEqual(ex.gana_precio, ['MLU1', 'MLU2', 'MLU4', 'MLU6']);
    assert.deepEqual(ex.sin_competencia, [], 'not_listed (fuera del catálogo) entra a la liquidación');
});

test('médicos: cualquier ruta con medicina-salud', () => {
    assert.deepEqual(medicalIds(TOPICS), ['MLU2', 'MLU8']);
});
