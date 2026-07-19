import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createOrdersHandler } from '../_orders_handler.js';
import { consolidateItems, generateFingerprint } from '../_orders_logic.js';

// ── Catálogo de prueba ────────────────────────────────────────────────────────

const CATALOG = {
  items: [
    { id: 'MLU1', title: 'Libro Alpha', price: 1000, available_quantity: 5,  status: 'active', thumbnail: null },
    { id: 'MLU2', title: 'Libro Beta',  price: 1250, available_quantity: 3,  status: 'active', thumbnail: null },
    { id: 'MLU3', title: 'Sin Stock',   price: 500,  available_quantity: 0,  status: 'active', thumbnail: null },
    { id: 'MLU4', title: 'Pausado',     price: 300,  available_quantity: 10, status: 'paused', thumbnail: null },
    { id: 'MLU5', title: 'Libro Gamma', price: 800,  available_quantity: 5,  status: 'active', thumbnail: null },
  ],
};

// ── Mock D1 ───────────────────────────────────────────────────────────────────

function makeMockDb({ existingOrders = [], collidePublicCodes = [], batchError = null } = {}) {
  const committed = [];
  return {
    _committed: committed,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              const sq = sql.toLowerCase();
              if (sq.includes('idempotency_key') && !sq.includes('insert')) {
                return existingOrders.find(o => o.idempotency_key === args[0]) || null;
              }
              if (sq.includes('public_code') && !sq.includes('insert')) {
                return collidePublicCodes.includes(args[0]) ? { id: 'taken' } : null;
              }
              return null;
            },
          };
        },
      };
    },
    async batch(stmts) {
      if (batchError) throw batchError;
      committed.push(...stmts);
      return stmts.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(body, db, opts = {}) {
  const { method = 'POST', contentType = 'application/json', contentLength } = opts;
  const headers = { 'Content-Type': contentType };
  if (contentLength != null) headers['Content-Length'] = String(contentLength);
  return {
    request: new Request('https://test.amadolibros.com/api/orders', {
      method,
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env: db ? { ORDERS_DB: db } : {},
    waitUntil: () => {},
  };
}

const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

const pickupBody = (key = 'k-pickup') => ({
  idempotency_key: key,
  items: [{ product_id: 'MLU1', quantity: 2 }, { product_id: 'MLU2', quantity: 1 }],
  delivery_type: 'pickup',
  buyer: { name: 'Ana García', phone: '099111222' },
});

const shippingBody = (key = 'k-ship', extra = {}) => ({
  idempotency_key: key,
  items: [{ product_id: 'MLU5', quantity: 1 }, { product_id: 'MLU1', quantity: 1 }],
  delivery_type: 'shipping',
  buyer: { name: 'Carlos López', phone: '098000111' },
  shipping: {
    address:        'Av. 18 de Julio 1360',
    locality:       'Centro',
    department:     'Montevideo',
    requested_date: tomorrow,
    requested_from: '09:00',
    requested_to:   '12:00',
  },
  ...extra,
});

// Handler por defecto
const handler = createOrdersHandler({ fetchCatalog: async () => CATALOG });

// ── Tests ─────────────────────────────────────────────────────────────────────

// 1. Retiro 3.250 → payable 3.100 (descuento 150)
test('retiro subtotal=3250 → discount=150, payable=3100', async () => {
  // MLU1×2 (2000) + MLU2×1 (1250) = 3250
  const db   = makeMockDb();
  const resp = await handler(makeCtx(pickupBody(), db));
  const data = await resp.json();
  assert.equal(resp.status, 201);
  assert.equal(data.order.products_total_uyu,  3250);
  assert.equal(data.order.pickup_discount_uyu, 150);
  assert.equal(data.order.shipping_cost_uyu,   0);
  assert.equal(data.order.payable_total_uyu,   3100);
});

// 2. Envío subtotal=1.800 → shipping=250, payable=2.050
test('envío subtotal=1800 → shipping=250, payable=2050', async () => {
  // MLU5 (800) + MLU1 (1000) = 1800
  const db   = makeMockDb();
  const resp = await handler(makeCtx(shippingBody('k2'), db));
  const data = await resp.json();
  assert.equal(resp.status, 201);
  assert.equal(data.order.products_total_uyu,  1800);
  assert.equal(data.order.shipping_cost_uyu,   250);
  assert.equal(data.order.payable_total_uyu,   2050);
  assert.equal(data.order.pickup_discount_uyu, 0);
});

// 3. Envío subtotal=2.000 → envío gratis, payable=2.000
test('envío subtotal=2000 → envío gratis, payable=2000', async () => {
  // MLU1×2 = 2000
  const db   = makeMockDb();
  const body = {
    idempotency_key: 'k3',
    items: [{ product_id: 'MLU1', quantity: 2 }],
    delivery_type: 'shipping',
    buyer: { name: 'Test', phone: '099' },
    shipping: {
      address: 'Calle 1', locality: 'Ciudad', department: 'Montevideo',
      requested_date: tomorrow, requested_from: '09:00', requested_to: '12:00',
    },
  };
  const resp = await handler(makeCtx(body, db));
  const data = await resp.json();
  assert.equal(resp.status, 201);
  assert.equal(data.order.shipping_cost_uyu,  0);
  assert.equal(data.order.payable_total_uyu,  2000);
});

// 4. Envío subtotal=3.250 → envío gratis, payable=3.250
test('envío subtotal=3250 → envío gratis, payable=3250', async () => {
  // MLU1×2 (2000) + MLU2×1 (1250) = 3250
  const db   = makeMockDb();
  const body = {
    idempotency_key: 'k4',
    items: [{ product_id: 'MLU1', quantity: 2 }, { product_id: 'MLU2', quantity: 1 }],
    delivery_type: 'shipping',
    buyer: { name: 'Test', phone: '099' },
    shipping: {
      address: 'Calle 1', locality: 'Ciudad', department: 'Montevideo',
      requested_date: tomorrow, requested_from: '09:00', requested_to: '12:00',
    },
  };
  const resp = await handler(makeCtx(body, db));
  const data = await resp.json();
  assert.equal(resp.status, 201);
  assert.equal(data.order.shipping_cost_uyu,  0);
  assert.equal(data.order.payable_total_uyu,  3250);
});

// 5. expires_at exactamente 60 minutos después de created_at
test('expires_at es 60 minutos después del momento de creación', async () => {
  const fixedNow = new Date('2026-08-01T10:00:00.000Z');
  const h = createOrdersHandler({
    fetchCatalog: async () => CATALOG,
    getNow: () => new Date(fixedNow),
  });
  const db   = makeMockDb();
  const resp = await h(makeCtx(pickupBody('k5'), db));
  const data = await resp.json();
  assert.equal(resp.status, 201);
  assert.equal(data.order.expires_at, '2026-08-01T11:00:00.000Z');
});

// 6. Misma idempotency_key + mismo fingerprint → 200 con la misma orden
test('misma idempotency_key y mismo fingerprint → 200 con orden existente', async () => {
  const body         = pickupBody('k6');
  const consolidated = consolidateItems(body.items);
  const fingerprint  = generateFingerprint(body, consolidated);

  const stored = {
    idempotency_key:     'k6',
    request_fingerprint: fingerprint,
    public_code:         'AL-260801-IDEMOK',
    status:              'open',
    payment_status:      'not_started',
    delivery_type:       'pickup',
    products_total_uyu:  3250,
    pickup_discount_uyu: 150,
    shipping_cost_uyu:   0,
    payable_total_uyu:   3100,
    currency:            'UYU',
    expires_at:          '2026-08-01T11:00:00.000Z',
  };

  const db   = makeMockDb({ existingOrders: [stored] });
  const resp = await handler(makeCtx(body, db));
  const data = await resp.json();
  assert.equal(resp.status, 200);
  assert.equal(data.order.public_code, 'AL-260801-IDEMOK');
});

// 7. Misma idempotency_key + distinto fingerprint → 409
test('misma idempotency_key y distinto fingerprint → 409', async () => {
  const stored = {
    idempotency_key:     'k7',
    request_fingerprint: 'fingerprint-de-otro-pedido',
    public_code:         'AL-260801-OTHER',
    status:              'open',
    payment_status:      'not_started',
    delivery_type:       'pickup',
    products_total_uyu:  1000,
    pickup_discount_uyu: 150,
    shipping_cost_uyu:   0,
    payable_total_uyu:   850,
    currency:            'UYU',
    expires_at:          '2026-08-01T11:00:00.000Z',
  };

  const db   = makeMockDb({ existingOrders: [stored] });
  const resp = await handler(makeCtx(pickupBody('k7'), db));
  assert.equal(resp.status, 409);
});

// 8. Stock insuficiente → 422
test('stock insuficiente → 422', async () => {
  const body = {
    idempotency_key: 'k8',
    items: [{ product_id: 'MLU1', quantity: 99 }], // solo 5 disponibles
    delivery_type: 'pickup',
    buyer: { name: 'Test', phone: '099' },
  };
  const db   = makeMockDb();
  const resp = await handler(makeCtx(body, db));
  const data = await resp.json();
  assert.equal(resp.status, 422);
  assert.ok(Array.isArray(data.details));
  assert.ok(data.details.some(e => /insuficiente/i.test(e)));
});

// 9. Producto inexistente → 422
test('producto inexistente en catálogo → 422', async () => {
  const body = {
    idempotency_key: 'k9',
    items: [{ product_id: 'MLUNOPE', quantity: 1 }],
    delivery_type: 'pickup',
    buyer: { name: 'Test', phone: '099' },
  };
  const db   = makeMockDb();
  const resp = await handler(makeCtx(body, db));
  const data = await resp.json();
  assert.equal(resp.status, 422);
  assert.ok(Array.isArray(data.details));
  assert.ok(data.details.some(e => /no encontrado/i.test(e)));
});

// 10. Envío sin dirección/localidad/departamento → 400
test('envío sin dirección requerida → 400', async () => {
  const body = {
    idempotency_key: 'k10',
    items: [{ product_id: 'MLU1', quantity: 1 }],
    delivery_type: 'shipping',
    buyer: { name: 'Test', phone: '099' },
    shipping: {
      address: '',          // vacío
      locality: 'Centro',
      department: 'Montevideo',
      requested_date: tomorrow,
      requested_from: '09:00',
      requested_to: '12:00',
    },
  };
  const db   = makeMockDb();
  const resp = await handler(makeCtx(body, db));
  assert.equal(resp.status, 400);
});

// 11. Fecha pasada → 400
test('fecha de entrega en el pasado → 400', async () => {
  const body = shippingBody('k11');
  body.shipping.requested_date = '2020-01-01'; // siempre en el pasado
  const db   = makeMockDb();
  const resp = await handler(makeCtx(body, db));
  assert.equal(resp.status, 400);
});

// 12. requested_to ≤ requested_from → 400
test('requested_to menor o igual a requested_from → 400', async () => {
  const body = shippingBody('k12');
  body.shipping.requested_from = '14:00';
  body.shipping.requested_to   = '10:00'; // antes que from
  const db   = makeMockDb();
  const resp = await handler(makeCtx(body, db));
  assert.equal(resp.status, 400);
});

// 13. precio/título enviados por el cliente son ignorados; total viene del catálogo
test('price/title del cliente ignorados: total usa precios del catálogo', async () => {
  const body = {
    idempotency_key: 'k13',
    items: [
      { product_id: 'MLU1', quantity: 1, price: 99999, title: 'Título falso' },
    ],
    delivery_type: 'pickup',
    buyer: { name: 'Test', phone: '099' },
  };
  const db   = makeMockDb();
  const resp = await handler(makeCtx(body, db));
  const data = await resp.json();
  assert.equal(resp.status, 201);
  // El precio real de MLU1 en el catálogo es 1000, no 99999
  assert.equal(data.order.products_total_uyu, 1000);
  assert.equal(data.order.payable_total_uyu,  850); // 1000 - 150 descuento retiro
});

// 14. Fallo del batch → 500 sin orden huérfana
test('fallo del batch → 500 y nada queda commiteado', async () => {
  const db = makeMockDb({ batchError: new Error('D1 connection error') });
  const resp = await handler(makeCtx(pickupBody('k14'), db));
  assert.equal(resp.status, 500);
  assert.equal(db._committed.length, 0, 'no deben haber statements commiteados');
});

// 15. La respuesta 201 no expone el id interno
test('respuesta 201 no expone id interno', async () => {
  const db   = makeMockDb();
  const resp = await handler(makeCtx(pickupBody('k15'), db));
  const data = await resp.json();
  assert.equal(resp.status, 201);
  assert.ok(!Object.hasOwn(data, 'id'));
  assert.ok(!Object.hasOwn(data.order, 'id'));
  assert.ok(typeof data.order.public_code === 'string');
});

// 16. buyer.name y buyer.phone obligatorios → 400
test('buyer.name ausente → 400', async () => {
  const body = {
    idempotency_key: 'k16a',
    items: [{ product_id: 'MLU1', quantity: 1 }],
    delivery_type: 'pickup',
    buyer: { name: '', phone: '099123456' },
  };
  const db   = makeMockDb();
  const resp = await handler(makeCtx(body, db));
  assert.equal(resp.status, 400);

  const body2 = {
    idempotency_key: 'k16b',
    items: [{ product_id: 'MLU1', quantity: 1 }],
    delivery_type: 'pickup',
    buyer: { name: 'Test', phone: '' },
  };
  const resp2 = await handler(makeCtx(body2, db));
  assert.equal(resp2.status, 400);
});

// 17. ORDERS_DB ausente → 503
test('ORDERS_DB ausente en env → 503', async () => {
  const resp = await handler(makeCtx(pickupBody('k17'), null));
  const data = await resp.json();
  assert.equal(resp.status, 503);
  assert.ok(typeof data.error === 'string');
});

// 18. Body excesivo o Content-Type incorrecto → 413 / 415
test('body excesivo → 413 y Content-Type incorrecto → 415', async () => {
  // Content-Length indica cuerpo > 32 KB
  const respBig = await handler(
    makeCtx('{}', makeMockDb(), { contentLength: 33 * 1024 + 1 })
  );
  assert.equal(respBig.status, 413);

  // Content-Type no es application/json
  const respCt = await handler(
    makeCtx('{}', makeMockDb(), { contentType: 'text/plain' })
  );
  assert.equal(respCt.status, 415);
});
