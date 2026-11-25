// Premio de la Rueda y el Acertijo usado al pagar en la web (JUEGO-4).
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { calcularPremioPedido, marcarPremioUsadoStmt, avisoPremio } from '../_shared/premio-web.js';
import { createOrdersHandler } from '../api/_orders_handler.js';
import { createPremioHandler } from '../api/_premio_handler.js';
import { createRuedaHandler } from '../api/_rueda_handler.js';
import { calculateTransferTotals } from '../api/_orders_logic.js';
import { transferAmountFor, confirmTransfer } from '../_shared/panel-transfer.js';
import { premioGanadoEmail, premioCanjeadoEmail } from '../_shared/premio-avisos.js';
import { umbralPremioEntero } from '../_shared/juego.js';

const NOW = new Date('2026-11-12T15:00:00.000Z');

function d1() {
    const db = new DatabaseSync(':memory:');
    const orders = readdirSync('migrations').filter(n => /^00(0\d|1\d|20)_/.test(n) && n.includes('orders')).sort();
    for (const name of orders) db.exec(readFileSync(`migrations/${name}`, 'utf8'));
    for (const name of ['0017_juego_codigos.sql', '0018_juego_acertijo.sql', '0019_juego_premios_en_pesos.sql', '0021_juego_codigos_canje.sql']) {
        db.exec(readFileSync(`migrations/${name}`, 'utf8'));
    }
    const wrap = sql => {
        const stmt = db.prepare(sql);
        const bound = (...args) => ({
            sql,
            args,
            first: async () => stmt.get(...args) ?? null,
            all: async () => ({ results: stmt.all(...args) }),
            run: async () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
            _run: () => { const r = stmt.run(...args); return { meta: { changes: Number(r.changes) } }; },
        });
        return { bind: bound, ...bound() };
    };
    return {
        raw: db,
        prepare: wrap,
        async batch(stmts) {
            db.exec('BEGIN');
            try {
                const out = stmts.map(s => s._run());
                db.exec('COMMIT');
                return out;
            } catch (e) {
                db.exec('ROLLBACK');
                throw e;
            }
        },
    };
}

// Libros del catálogo: precio de liquidación (price) y habitual (original_price).
const CATALOG = { items: [
    { id: 'CARO', title: 'Libro caro', price: 1800, original_price: 2000, available_quantity: 3, status: 'active' },
    { id: 'MEDIO', title: 'Libro medio', price: 1350, original_price: 1500, available_quantity: 3, status: 'active' },
    { id: 'BARATO', title: 'Libro barato', price: 950, original_price: 950, available_quantity: 3, status: 'active' },
] };

function snap(ids) {
    return ids.map(([id, qty = 1]) => {
        const c = CATALOG.items.find(i => i.id === id);
        return { product_id: id, title: c.title, unit_price_uyu: c.price, quantity: qty, line_total_uyu: c.price * qty, habitual_unit_uyu: c.original_price };
    });
}

function insertarCodigo(db, { code = 'LIB-AAAAA', monto = 200, expira = '2026-11-15T15:00:00.000Z', used = null } = {}) {
    db.raw.prepare(
        "INSERT INTO juego_codigos (code, origen, monto_uyu, wa_hash, dia, created_at, expires_at, used_at) VALUES (?, 'rueda', ?, ?, '2026-11-12', '2026-11-12T15:00:00.000Z', ?, ?)"
    ).run(code, monto, 'h-' + code, expira, used);
}

const ENV = db => ({
    APP_ENV: 'preview', MP_COLLECTOR_ID: '3559407834', CHECKOUT_ENABLED: 'true',
    CANONICAL_ORIGIN: 'https://preview.amadolibros-web.pages.dev', ORDERS_DB: db, TURNSTILE_SECRET_KEY: 'x',
});

function pedido(key, { items = [{ product_id: 'CARO', quantity: 1 }], premio = 'LIB-AAAAA', delivery = 'pickup' } = {}) {
    const body = {
        idempotency_key: key, cf_turnstile_response: 'ok', items, delivery_type: delivery,
        buyer: { name: 'Ana', phone: '099123456', email: 'ana@example.com' },
    };
    if (delivery === 'pickup') body.pickup_ack = true;
    if (delivery === 'shipping') body.shipping = { address: 'Calle 1', locality: 'Centro', department: 'Montevideo' };
    if (premio) body.premio_code = premio;
    return body;
}

const ordersHandler = () => createOrdersHandler({
    fetchCatalog: async () => CATALOG, getNow: () => NOW, verifyTurnstileToken: async () => ({ ok: true }),
});

async function crear(db, body) {
    const req = new Request('https://x/api/orders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const res = await ordersHandler()({ request: req, env: ENV(db), waitUntil() {} });
    return { status: res.status, data: await res.json() };
}

test('el premio va al libro donde más descuenta y respeta tope y piso', () => {
    const row = { monto_uyu: 200 };
    const calc = calcularPremioPedido(snap([['MEDIO'], ['CARO'], ['BARATO']]), row, NOW);
    assert.equal(calc.aplicado, true);
    assert.equal(calc.product_id, 'CARO');
    // $2.000 habitual: 10 % + $200 = $400 → $1.600; frente a $1.800 baja $200.
    assert.equal(calc.descuento_uyu, 200);
    assert.equal(calc.entero, true);
    // Por transferencia: 10 % + $200 + 12 % = $640 (32 %) → tope 30 % = $600 → $1.400.
    // Sin premio la transferencia deja el libro en $1.584 (12 % sobre $1.800): el premio baja $184.
    assert.equal(calc.descuento_transfer_uyu, 184);
    assert.equal(avisoPremio(calc), '');
});

test('premio grande en libro chico: rinde menos y lo avisa; bajo $1.000 no se aplica', () => {
    const parcial = calcularPremioPedido(snap([['MEDIO']]), { monto_uyu: 450 }, NOW);
    // $1.500 habitual con $450: tope 30 % = $450 → $1.050, frente a $1.350 baja $300.
    assert.equal(parcial.aplicado, true);
    assert.equal(parcial.descuento_uyu, 300);
    assert.equal(parcial.entero, false);
    assert.equal(parcial.umbral_uyu, umbralPremioEntero(450));
    assert.match(avisoPremio(parcial), /te descuenta \$300\. En un libro desde \$2\.030 lo aprovechás entero/);

    const nada = calcularPremioPedido(snap([['BARATO']]), { monto_uyu: 200 }, NOW);
    assert.equal(nada.aplicado, false);
    assert.match(avisoPremio(nada), /queda guardado para un libro desde \$1\.200/);
});

test('POST /api/orders con premio: descuenta, reserva el código y guarda el libro', async () => {
    const db = d1();
    insertarCodigo(db);
    const { status, data } = await crear(db, pedido('k1'));
    assert.equal(status, 201);
    assert.equal(data.order.premio_discount_uyu, 200);
    // Retiro: $1.800 − $150 de retiro − $200 de premio.
    assert.equal(data.order.payable_total_uyu, 1450);
    assert.equal(data.premio.title, 'Libro caro');
    const fila = db.raw.prepare("SELECT order_id, reservado_hasta, used_at FROM juego_codigos WHERE code='LIB-AAAAA'").get();
    const order = db.raw.prepare('SELECT id, premio_code, premio_product_id, premio_discount_uyu, premio_transfer_discount_uyu, expires_at FROM orders').get();
    assert.equal(fila.order_id, order.id);
    assert.equal(fila.reservado_hasta, order.expires_at);
    assert.equal(fila.used_at, null);
    assert.equal(order.premio_code, 'LIB-AAAAA');
    assert.equal(order.premio_product_id, 'CARO');

    // Repetir el mismo pedido devuelve el mismo, con el premio.
    const again = await crear(db, pedido('k1'));
    assert.equal(again.status, 200);
    assert.equal(again.data.order.premio_discount_uyu, 200);
});

test('el premio nunca hace aparecer un costo de envío', async () => {
    const db = d1();
    insertarCodigo(db);
    // $1.800 ya tiene envío gratis (desde $1.500); con el premio queda en $1.600 y sigue gratis.
    const { data } = await crear(db, pedido('envio', { delivery: 'shipping' }));
    assert.equal(data.order.shipping_cost_uyu, 0);
    assert.equal(data.order.payable_total_uyu, 1600);
});

test('código usado, vencido o inexistente: 409 claro y no se crea el pedido', async () => {
    const db = d1();
    insertarCodigo(db, { code: 'LIB-USADA', used: '2026-11-12T10:00:00.000Z' });
    insertarCodigo(db, { code: 'LIB-VENCE', expira: '2026-11-12T14:00:00.000Z' });
    for (const [code, estado] of [['LIB-USADA', 'usado'], ['LIB-VENCE', 'vencido'], ['LIB-NHAYA', 'inexistente'], ['XX', 'formato']]) {
        const r = await crear(db, pedido('k-' + code, { premio: code }));
        assert.equal(r.status, 409, code);
        assert.equal(r.data.code, 'PREMIO_NO_DISPONIBLE');
        assert.equal(r.data.premio_estado, estado);
    }
    assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 0);
});

test('libro de $1.000 o menos: el pedido sale sin premio y el código no se gasta', async () => {
    const db = d1();
    insertarCodigo(db);
    const r = await crear(db, pedido('barato', { items: [{ product_id: 'BARATO', quantity: 1 }] }));
    assert.equal(r.status, 201);
    assert.equal(r.data.order.premio_discount_uyu, 0);
    assert.equal(r.data.premio.aplicado, false);
    assert.equal(db.raw.prepare("SELECT order_id FROM juego_codigos WHERE code='LIB-AAAAA'").get().order_id, null);
    assert.equal(db.raw.prepare('SELECT premio_code FROM orders').get().premio_code, null);
});

test('reserva: otro pedido sin pagar libera el premio; uno pagado lo gasta', async () => {
    const db = d1();
    insertarCodigo(db);
    const a = await crear(db, pedido('a'));
    assert.equal(a.status, 201);
    // El cliente vuelve atrás y arma otro pedido: el primero nunca empezó a pagarse.
    const b = await crear(db, pedido('b', { items: [{ product_id: 'CARO', quantity: 2 }] }));
    assert.equal(b.status, 201);
    const orderB = db.raw.prepare("SELECT id FROM orders WHERE idempotency_key='b'").get();
    assert.equal(db.raw.prepare("SELECT order_id FROM juego_codigos WHERE code='LIB-AAAAA'").get().order_id, orderB.id);

    // Si el pedido B ya está pagándose, un tercer pedido no puede tomar el premio.
    db.raw.prepare("UPDATE orders SET payment_status='pending' WHERE id=?").run(orderB.id);
    const c = await crear(db, pedido('c'));
    assert.equal(c.status, 409);
    assert.equal(c.data.premio_estado, 'reservado');

    // Se aprueba el pago de B: el premio queda usado, en la web, con su libro.
    await db.batch([marcarPremioUsadoStmt(db, orderB.id, '2026-11-12T15:10:00.000Z')]);
    const fila = db.raw.prepare("SELECT used_at, canal, libro, descuento_uyu, order_id FROM juego_codigos WHERE code='LIB-AAAAA'").get();
    assert.deepEqual({ ...fila }, { used_at: '2026-11-12T15:10:00.000Z', canal: 'web', libro: 'Libro caro', descuento_uyu: 200, order_id: orderB.id });
    const d = await crear(db, pedido('d'));
    assert.equal(d.data.premio_estado, 'usado');
});

test('transferencia: el total descuenta el premio de transferencia y la confirmación lo gasta', async () => {
    const db = d1();
    insertarCodigo(db);
    const { data } = await crear(db, pedido('t1'));
    const order = db.raw.prepare("SELECT * FROM orders WHERE idempotency_key='t1'").get();
    // El premio ya viene descontado: productos $1.800 − $200 = $1.600 (Mercado Pago)
    // y por transferencia el libro de $2.000 habitual queda en $1.400 (tope 30 %).
    assert.equal(order.products_total_uyu, 1600);
    assert.equal(order.transfer_products_total_uyu, 1400);
    assert.equal(order.payable_total_uyu, order.products_total_uyu - order.pickup_discount_uyu + order.shipping_cost_uyu);
    const totales = calculateTransferTotals({
        productsTotal: order.products_total_uyu, pickupDiscount: order.pickup_discount_uyu, shippingCost: order.shipping_cost_uyu,
        transferProductsTotal: order.transfer_products_total_uyu,
    });
    assert.equal(transferAmountFor(order).amount, totales.transferPayableTotal);
    assert.equal(transferAmountFor(order).amount, 1250, '$1.400 − $150 de retiro');
    assert.equal(order.premio_transfer_discount_uyu, 184, 'sin premio la transferencia dejaba el libro en $1.584');
    assert.equal(data.order.premio_transfer_discount_uyu, 184);

    const r = await confirmTransfer({ db, order, now: new Date('2026-11-12T16:00:00.000Z') });
    assert.equal(r.ok, true);
    const fila = db.raw.prepare("SELECT used_at, canal, descuento_uyu FROM juego_codigos WHERE code='LIB-AAAAA'").get();
    assert.equal(fila.canal, 'web');
    assert.equal(fila.descuento_uyu, order.premio_transfer_discount_uyu);
});

test('POST /api/premio: vista previa sin reservar ni gastar', async () => {
    const db = d1();
    insertarCodigo(db);
    const h = createPremioHandler({ fetchCatalog: async () => CATALOG, getNow: () => NOW });
    const call = async body => {
        const res = await h({ request: new Request('https://x/api/premio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env: { ORDERS_DB: db } });
        return { status: res.status, data: await res.json() };
    };
    const ok = await call({ code: 'lib aaaaa', items: [{ product_id: 'CARO', quantity: 1 }] });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);
    assert.equal(ok.data.premio.descuento_uyu, 200);
    assert.equal(db.raw.prepare("SELECT order_id FROM juego_codigos WHERE code='LIB-AAAAA'").get().order_id, null);
    const mal = await call({ code: 'LIB-ZZZZZ', items: [{ product_id: 'CARO', quantity: 1 }] });
    assert.equal(mal.data.ok, false);
    assert.equal(mal.data.premio_estado, 'inexistente');
    const vacio = await call({ code: 'LIB-AAAAA', items: [] });
    assert.equal(vacio.status, 400);
});

test('mails de premios: ganado y canjeado, sin datos del cliente', async () => {
    const g = premioGanadoEmail({ code: 'LIB-AAAAA', origen: 'rueda', monto_uyu: 200, expires_at: '2026-11-15T15:00:00.000Z', umbral_uyu: 1200 });
    assert.match(g.subject, /Premio de \$200 en la Rueda del Librero — LIB-AAAAA/);
    assert.match(g.text, /desde \$1\.200/);
    const c = premioCanjeadoEmail({ code: 'LIB-AAAAA', monto_uyu: 200, libro: 'Rayuela', precio_habitual: 2000, descuento_uyu: 400 });
    assert.match(c.text, /Libro: Rayuela/);
    assert.match(c.subject, /WhatsApp/);

    // La Rueda manda el mail en segundo plano cuando Resend está configurado.
    const db = d1();
    const enviados = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (url, init) => { enviados.push({ url, body: JSON.parse(init.body), key: init.headers['Idempotency-Key'] }); return new Response('{"id":"x"}', { status: 200 }); };
    try {
        const pend = [];
        const h = createRuedaHandler({ getNow: () => NOW, roll: () => 35, codeBytes: () => Uint8Array.from([1, 2, 3, 4, 5]) });
        const res = await h({
            request: new Request('https://www.amadolibros.com/api/rueda', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ whatsapp: '099841325' }) }),
            env: { ORDERS_DB: db, RESEND_API_KEY: 'k', SALES_NOTIFICATION_FROM: 'Amado <v@amadolibros.com>', SALES_NOTIFICATION_TO: 'a@x.com' },
            waitUntil: p => pend.push(p),
        });
        await Promise.all(pend);
        const data = await res.json();
        assert.equal(res.status, 201);
        assert.equal(data.valid_hours, 72);
        assert.equal(data.umbral_uyu, umbralPremioEntero(data.monto_uyu));
        assert.equal(enviados.length, 1);
        assert.equal(enviados[0].key, `premio-ganado/${data.code}`);
        assert.match(enviados[0].body.subject, new RegExp(data.code));
        assert.doesNotMatch(JSON.stringify(enviados[0].body), /099841325|98841325/);
    } finally {
        globalThis.fetch = original;
    }
});
