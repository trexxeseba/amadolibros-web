import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { selectLiquidation, sortLiquidation, recentSales, LIQUIDACION } from '../_shared/liquidacion.js';
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

test('sin datos de ventas, la selección queda por antigüedad', () => {
    const items = [book('MLU1'), book('MLU7'), book('MLU2', { start_time: iso(30) })];
    assert.deepEqual(selectLiquidation(items, null, NOW).map(i => i.id), ['MLU1', 'MLU7']);
});

test('la selección no toca precios', () => {
    const item = book('MLU1', { price: 1990, original_price: 2340 });
    const [out] = selectLiquidation([item], null, NOW);
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
