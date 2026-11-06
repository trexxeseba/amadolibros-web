import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import {
    MAX_TOTAL_DISCOUNT, PRICE_FLOOR_UYU, LIQUIDACION_PRECIO,
    discountRulesActive, liquidationPrice, transferUnitDiscount,
    transferDisplayPrice, transferProductsTotal,
} from '../_shared/descuentos.js';
import { applyLiquidationPrices, resolveLiquidation, liquidationIds } from '../_shared/liquidacion.js';
import { applyWebPromoToItems, promoWasHtml, secondsToNextPromoBoundary } from '../_shared/web-promo.js';
import {
    buildSnapshot, calculateTransferTotals, transferProductsTotalForSnapshot, TRANSFER_FACTOR,
} from '../api/_orders_logic.js';

const BEFORE = new Date('2026-11-09T23:59:59-03:00');
const AFTER = new Date('2026-11-10T00:00:00-03:00');
const DAY = 86400000;

function book(id, extra = {}) {
    return {
        id, title: `Libro ${id}`, price: 2000, currency: 'UYU', status: 'active',
        available_quantity: 2, start_time: new Date(AFTER.getTime() - 800 * DAY).toISOString(), ...extra,
    };
}

const DATA = {
    lista: { ids: ['MLU1', 'MLU2', 'MLU3'] },
    excluir: { medicos: { ids: [] }, recientes: { ids: [] }, gana_precio: { ids: [] }, sin_competencia: { ids: [] } },
};

// ── Constante única y regla ──────────────────────────────────────────────

test('MAX_TOTAL_DISCOUNT es 25 % y es la única definición del tope', () => {
    assert.equal(MAX_TOTAL_DISCOUNT, 0.25);
    assert.equal(PRICE_FLOOR_UYU, 1200);
    const offenders = [];
    const walk = dir => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) { if (!['__tests__', '_vendor', 'node_modules'].includes(entry.name)) walk(path); continue; }
            if (!/\.m?js$/.test(entry.name)) continue;
            if (/export const MAX_TOTAL_DISCOUNT\b/.test(readFileSync(path, 'utf8'))) offenders.push(path);
        }
    };
    walk('functions');
    assert.deepEqual(offenders, ['functions/_shared/descuentos.js']);
});

test('la regla nueva entra el 10/11/2026 00:00 hora de Montevideo, ni un segundo antes', () => {
    assert.equal(LIQUIDACION_PRECIO.startsAt, '2026-11-10T00:00:00-03:00');
    assert.equal(discountRulesActive(BEFORE), false);
    assert.equal(discountRulesActive(AFTER), true);
    assert.equal(AFTER.toISOString(), '2026-11-10T03:00:00.000Z');
});

test('las páginas cacheadas vencen justo al entrar la regla nueva', () => {
    const tenMinBefore = new Date(AFTER.getTime() - 600000);
    assert.equal(secondsToNextPromoBoundary(tenMinBefore), 600);
});

// ── Precio de liquidación y piso ─────────────────────────────────────────

test('el descuento base de la liquidación es 10 % y nunca pasa el tope', () => {
    assert.equal(LIQUIDACION_PRECIO.discount, 0.10, 'Seba fijó la base en 10 % el 5/11/2026');
    assert.ok(LIQUIDACION_PRECIO.discount <= MAX_TOTAL_DISCOUNT);
});

test('liquidación: 10 % sobre el habitual y piso de $1.200', () => {
    assert.deepEqual(liquidationPrice(2000), { price: 1800, applied: true, reason: 'ok' });
    assert.equal(liquidationPrice(1999).price, 1799); // 1799,1
    assert.equal(liquidationPrice(1334).price, 1201);
    assert.equal(liquidationPrice(1333).price, 1200); // 1199,7 → 1200: entra justo
    assert.deepEqual(liquidationPrice(1332), { price: 1332, applied: false, reason: 'bajo_piso' }); // 1198,8 → 1199
    assert.deepEqual(liquidationPrice(900), { price: 900, applied: false, reason: 'bajo_piso' });
    assert.equal(liquidationPrice(0).applied, false);
});

test('ningún precio de liquidación baja más de 25 % ni queda bajo $1.200', () => {
    for (let h = 1; h <= 30000; h++) {
        const r = liquidationPrice(h);
        if (!r.applied) { assert.equal(r.price, h); continue; }
        assert.ok(r.price >= PRICE_FLOOR_UYU, `piso con ${h}`);
        assert.ok(h - r.price <= h * MAX_TOTAL_DISCOUNT, `tope con ${h}`);
    }
});

// ── Transferencia con tope ───────────────────────────────────────────────

test('transferencia: antes del 10/11 el 12 % de siempre, también sobre Amado Week', () => {
    assert.equal(transferUnitDiscount(1700, 2000, BEFORE), 1700 * 0.12);
    assert.equal(transferDisplayPrice({ price: 1700, original_price: 2000 }, BEFORE), 1496);
});

test('transferencia: desde el 10/11 suma solo hasta el 25 % total', () => {
    // Sin descuento previo: 12 % entero.
    assert.equal(transferUnitDiscount(2000, 2000, AFTER), 240);
    assert.equal(transferDisplayPrice({ price: 2000 }, AFTER), 1760);
    // Liquidación base (10 %): la transferencia suma su 12 % sobre el precio de liquidación (≈ 20,8 % total).
    assert.equal(transferUnitDiscount(1800, 2000, AFTER), 216);
    assert.equal(transferDisplayPrice({ price: 1800, original_price: 2000, liquidation: true }, AFTER), 1584);
    // Un libro que ya está en el tope (25 %) no suma nada: único precio final.
    assert.equal(transferUnitDiscount(1500, 2000, AFTER), 0);
    assert.equal(transferDisplayPrice({ price: 1500, original_price: 2000, liquidation: true }, AFTER), null);
    // Descuento previo de 15 %: la transferencia completa hasta 25 % y no más.
    assert.equal(transferUnitDiscount(1700, 2000, AFTER), 200);
    assert.equal(transferDisplayPrice({ price: 1700, original_price: 2000 }, AFTER), 1500);
});

test('tope: ninguna combinación pasa el 25 % desde el 10/11', () => {
    for (let h = 1000; h <= 6000; h += 7) {
        for (const prior of [0, 0.05, 0.1, 0.15, 0.2, 0.25]) {
            const price = Math.ceil(h * (1 - prior)); // precio previo dentro del tope
            const transfer = price - transferUnitDiscount(price, h, AFTER);
            assert.ok(h - transfer <= h * MAX_TOTAL_DISCOUNT + 1e-9, `h=${h} prior=${prior}`);
        }
    }
});

test('total por transferencia: sin descuentos previos es idéntico al cálculo anterior', () => {
    for (const [prices, qtys] of [[[2000], [1]], [[1234, 999, 4567], [1, 3, 2]], [[150], [99]], [[1795, 2350], [2, 1]]]) {
        const lines = prices.map((p, i) => ({ unit_price_uyu: p, quantity: qtys[i], line_total_uyu: p * qtys[i] }));
        const total = lines.reduce((s, l) => s + l.line_total_uyu, 0);
        assert.equal(transferProductsTotal(lines, AFTER), Math.round(total * TRANSFER_FACTOR));
        assert.equal(transferProductsTotal(lines, BEFORE), Math.round(total * TRANSFER_FACTOR));
    }
});

test('total por transferencia: carrito mixto, el libro en liquidación no suma el 12 %', () => {
    const lines = [
        { unit_price_uyu: 1500, habitual_unit_uyu: 2000, quantity: 1, line_total_uyu: 1500 },
        { unit_price_uyu: 1000, habitual_unit_uyu: 1000, quantity: 2, line_total_uyu: 2000 },
    ];
    // El libro que ya está en el tope no suma el 12 %; el otro sí.
    assert.equal(transferProductsTotal(lines, AFTER), 3500 - 240);
    assert.equal(transferProductsTotal(lines, BEFORE), Math.round(3500 * 0.88));
});

// ── Catálogo: precio de liquidación ──────────────────────────────────────

test('catálogo: antes del 10/11 no cambia nada', () => {
    const items = [book('MLU1')];
    assert.equal(applyLiquidationPrices(items, { now: BEFORE, data: DATA }), items);
});

test('catálogo: desde el 10/11 pone precio de liquidación, habitual y marca; idempotente', () => {
    const items = [book('MLU1'), book('MLU2', { price: 1300 }), book('MLU9')];
    const out = applyLiquidationPrices(items, { now: AFTER, data: DATA });
    assert.deepEqual([out[0].price, out[0].original_price, out[0].liquidation], [1800, 2000, true]);
    assert.equal(out[1].price, 1300);
    assert.equal(out[1].liquidation_skip, 'bajo_piso'); // 1170 < 1200
    assert.equal(out[2], items[2]); // fuera de la lista
    assert.deepEqual(applyLiquidationPrices(out, { now: AFTER, data: DATA }), out);
});

test('catálogo: con promo web previa rige el mejor precio; no se acumulan ni el precio sube', () => {
    const promo = { name: 'X', percent: 15, startsAt: '2026-11-01T00:00:00-03:00', endsAt: '2026-11-30T23:59:59-03:00', endLabel: '30/11' };
    const withPromo = applyWebPromoToItems([book('MLU1')], { now: AFTER, promo });
    assert.equal(withPromo[0].price, 1700);
    const out = applyLiquidationPrices(withPromo, { now: AFTER, data: DATA });
    // Amado Week (15 %) es mejor que la base de 10 %: se queda el precio de la promo.
    assert.deepEqual([out[0].price, out[0].original_price, out[0].liquidation], [1700, 2000, true]);
    // Con una promo de 5 % gana la liquidación.
    const chica = applyWebPromoToItems([book('MLU1')], { now: AFTER, promo: { ...promo, percent: 5 } });
    assert.equal(chica[0].price, 1900);
    assert.equal(applyLiquidationPrices(chica, { now: AFTER, data: DATA })[0].price, 1800);
});

test('catálogo: LIQUIDACION_PRECIO_OFF=1 apaga el precio de liquidación', () => {
    const items = [book('MLU1')];
    assert.equal(applyLiquidationPrices(items, { now: AFTER, data: DATA, env: { LIQUIDACION_PRECIO_OFF: '1' } }), items);
});

test('catálogo: sin lista entregada no cambia ningún precio', () => {
    const items = [book('MLU1')];
    assert.equal(applyLiquidationPrices(items, { now: AFTER }), items);
});

test('vitrina y feed: desde el 10/11 los que quedan bajo el piso salen y se cuentan', async () => {
    const priced = applyLiquidationPrices([book('MLU1'), book('MLU2', { price: 1300 }), book('MLU3', { price: 1200 })], { now: AFTER, data: DATA });
    const r = await resolveLiquidation({ env: {} }, priced, { now: AFTER.getTime(), data: DATA });
    assert.deepEqual(r.selected.map(i => i.id), ['MLU1']);
    assert.equal(r.excluded.bajo_piso, 2);
    assert.deepEqual([...liquidationIds(priced, { now: AFTER.getTime(), data: DATA })], ['MLU1']);
    const before = await resolveLiquidation({ env: {} }, [book('MLU1'), book('MLU2', { price: 1300 })], { now: BEFORE.getTime(), data: DATA });
    assert.equal(before.selected.length, 2);
    assert.equal(before.excluded.bajo_piso, undefined);
});

test('etiqueta de precio: liquidación muestra el habitual tachado, sin la leyenda de Amado Week', () => {
    const html = promoWasHtml({ price: 1500, original_price: 2000, liquidation: true });
    assert.match(html, /Precio de liquidación/);
    assert.match(html, /<s>\$2\.000 UYU<\/s>/);
    assert.doesNotMatch(html, /Amado Week/);
});

// ── Cobro ────────────────────────────────────────────────────────────────

test('pedido: el snapshot guarda el habitual y el total por transferencia respeta el tope', () => {
    const catalog = [
        { id: 'MLU1', title: 'A', price: 1500, original_price: 2000, status: 'active', available_quantity: 3, currency: 'UYU' },
        { id: 'MLU2', title: 'B', price: 1000, status: 'active', available_quantity: 3, currency: 'UYU' },
    ];
    const { errors, snapshot } = buildSnapshot([{ product_id: 'MLU1', quantity: 1 }, { product_id: 'MLU2', quantity: 2 }], catalog);
    assert.deepEqual(errors, []);
    assert.deepEqual(snapshot.map(s => s.habitual_unit_uyu), [2000, 1000]);
    assert.equal(transferProductsTotalForSnapshot(snapshot, AFTER), 3260);
    assert.equal(transferProductsTotalForSnapshot(snapshot, BEFORE), Math.round(3500 * 0.88));
});

test('transferencia: usa el total guardado; pedidos viejos (NULL) siguen como antes', () => {
    const base = { productsTotal: 3500, pickupDiscount: 0, shippingCost: 0 };
    assert.equal(calculateTransferTotals({ ...base, transferProductsTotal: 3260 }).transferProductsTotal, 3260);
    assert.equal(calculateTransferTotals({ ...base, transferProductsTotal: 3260 }).transferDiscount, 240);
    assert.equal(calculateTransferTotals(base).transferProductsTotal, 3080);
    assert.equal(calculateTransferTotals({ ...base, transferProductsTotal: null }).transferProductsTotal, 3080);
    // Un valor guardado inválido nunca se usa.
    assert.equal(calculateTransferTotals({ ...base, transferProductsTotal: 9999 }).transferProductsTotal, 3080);
    assert.equal(calculateTransferTotals({ ...base, transferProductsTotal: -1 }).transferProductsTotal, 3080);
});

test('cobro: la orden guarda y la transferencia lee transfer_products_total_uyu (migración 0015)', () => {
    const migration = readFileSync('migrations/0015_orders_transfer_cap.sql', 'utf8');
    assert.match(migration, /ALTER TABLE orders ADD COLUMN transfer_products_total_uyu INTEGER;/);
    const ordersHandler = readFileSync('functions/api/_orders_handler.js', 'utf8');
    assert.match(ordersHandler, /transferProductsTotalForSnapshot\(snapshot, now\)/);
    assert.match(ordersHandler, /'transfer_products_total_uyu, '/);
    const transfer = readFileSync('functions/api/_transfer_options_handler.js', 'utf8');
    assert.match(transfer, /payable_total_uyu,transfer_products_total_uyu,currency/);
});

test('carrito y cobro leen el mismo catálogo con precio de liquidación', () => {
    const catalog = readFileSync('functions/_shared/catalog.js', 'utf8');
    assert.match(catalog, /applyLiquidationToCatalog\(applyWebPromoToCatalog\(/);
    assert.equal((catalog.match(/items: storeItems\(/g) || []).length, 2);
});

// ── Carrito del navegador: espejo del servidor ───────────────────────────

test('el carrito calcula el mismo total por transferencia que el servidor', () => {
    const src = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
    const consts = src.slice(src.indexOf('var TRANSFER_FACTOR'), src.indexOf("Date.parse('2026-11-10T00:00:00-03:00');") + 40);
    const fnStart = src.indexOf('function transferProductsTotalFor(subtotal)');
    const fnEnd = src.indexOf('\n    }\n', fnStart) + 7;
    assert.match(consts, /MAX_TOTAL_DISCOUNT\s*= 0\.25/);
    const carts = [
        [{ price: 1500, original_price: 2000, quantity: 1 }, { price: 1000, quantity: 2 }],
        [{ price: 2000, quantity: 1 }, { price: 1234, quantity: 3 }],
        [{ price: 1700, original_price: 2000, quantity: 2 }],
    ];
    for (const now of [BEFORE, AFTER]) {
        for (const items of carts) {
            const sandbox = {
                Date: { now: () => now.getTime(), parse: Date.parse },
                Math, Number,
                window: { AmadoCart: { get: () => ({ items }) } },
                getSellableItems: cart => cart.items,
            };
            const subtotal = items.reduce((s, i) => s + i.price * i.quantity, 0);
            const client = runInNewContext(`${consts}\n${src.slice(fnStart, fnEnd)}\ntransferProductsTotalFor(${subtotal});`, sandbox);
            const server = transferProductsTotal(items.map(i => ({
                unit_price_uyu: i.price, habitual_unit_uyu: i.original_price, quantity: i.quantity, line_total_uyu: i.price * i.quantity,
            })), now);
            assert.equal(client, server, `${now.toISOString()} ${JSON.stringify(items)}`);
        }
    }
});

test('carrito: si el tope recorta el 12 %, los textos dejan de prometerlo', () => {
    const src = readFileSync('astro-front/src/pages/carrito.astro', 'utf8');
    assert.match(src, /function syncTransferLabels/);
    assert.equal((src.match(/syncTransferLabels\(subtotal, transferProductsTotal(Ship)?\);/g) || []).length, 2);
});

// ── Pantallas: un único precio final en liquidación ──────────────────────

test('ficha, catálogo, temas y liquidación ocultan la línea de transferencia si no baja nada', () => {
    for (const path of ['functions/libro/[[path]].js', 'functions/catalogo.js', 'functions/libros/[[path]].js', 'functions/liquidacion.js']) {
        const src = readFileSync(path, 'utf8');
        assert.match(src, /transferDisplayPrice\(/, path);
        assert.doesNotMatch(src, /price \* 0\.88/, path);
    }
});

test('panel: «Transferencia recibida» marca el mismo monto que pagó el cliente', async () => {
    const { transferAmountFor } = await import('../_shared/panel-transfer.js');
    const base = { products_total_uyu: 3500, pickup_discount_uyu: 0, shipping_cost_uyu: 0, payable_total_uyu: 3500 };
    assert.equal(transferAmountFor({ ...base, transfer_products_total_uyu: 3260 }).amount, 3260);
    assert.equal(transferAmountFor(base).amount, 3080);
    const panelData = readFileSync('functions/_shared/panel-data.js', 'utf8');
    assert.match(panelData, /transfer_products_total_uyu,\n\s+currency, payment_provider/);
});

test('INSERT de pedidos: misma cantidad de columnas que de valores, y corre sobre las migraciones', async () => {
    const src = readFileSync('functions/api/_orders_handler.js', 'utf8');
    const start = src.indexOf("'INSERT INTO orders ('");
    const end = src.indexOf(').bind(', start);
    // eslint-disable-next-line no-new-func
    const sql = new Function(`return ${src.slice(start, end).trim().replace(/\)\s*$/, '')}`)();
    const [cols, vals] = sql.match(/\(([^)]*)\)\s*VALUES\s*\((.*)\)/s).slice(1);
    assert.equal(cols.split(',').length, vals.split(',').length);
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    for (const name of readdirSync('migrations').filter(n => /^00(0\d|1[0-5])_/.test(n) && n.includes('orders')).sort()) {
        db.exec(readFileSync(`migrations/${name}`, 'utf8'));
    }
    const sample = {
        id: 'o1', public_code: 'AL-1', idempotency_key: 'k1', request_fingerprint: 'f1',
        buyer_name: 'Ana', buyer_phone: '099', delivery_type: 'pickup',
        products_total_uyu: 3500, pickup_discount_uyu: 0, shipping_cost_uyu: 0, payable_total_uyu: 3500,
        transfer_products_total_uyu: 3260,
        created_at: '2026-11-10T03:00:00.000Z', expires_at: '2026-11-10T04:00:00.000Z', updated_at: '2026-11-10T03:00:00.000Z',
    };
    const names = cols.split(',').map(c => c.trim());
    const values = vals.split(',').map(v => v.trim())
        .map((v, i) => (v === '?' ? (sample[names[i]] ?? null) : undefined))
        .filter(v => v !== undefined);
    db.prepare(sql).run(...values);
    const row = db.prepare('SELECT products_total_uyu, transfer_products_total_uyu FROM orders').get();
    assert.deepEqual({ ...row }, { products_total_uyu: 3500, transfer_products_total_uyu: 3260 });
});
