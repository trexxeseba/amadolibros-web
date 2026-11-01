import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEB_PROMO,
  applyPromoToPrice,
  applyWebPromoToCatalog,
  applyWebPromoToItems,
  webPromoActive,
} from '../_shared/web-promo.js';
import { validateCartAgainstCatalog } from '../api/_orders_logic.js';

const DENTRO = new Date('2026-11-02T12:00:00-03:00');
const ANTES = new Date('2026-10-31T23:59:59-03:00');
const DESPUES = new Date('2026-11-10T00:00:00-03:00');

const items = () => [
  { id: 'MLU1', title: 'Uno', price: 1234, status: 'active', available_quantity: 3 },
  { id: 'MLU2', title: 'Dos', price: 65, status: 'active', available_quantity: 1 },
  { id: 'MLU3', title: 'Pausado', price: 900, status: 'paused', available_quantity: 0 },
  { id: 'MLU4', title: 'Sin precio', price: null, status: 'active', available_quantity: 1 },
];

test('la promo vale 15 % y solo dentro de su ventana de fechas', () => {
  assert.equal(WEB_PROMO.percent, 15);
  assert.equal(webPromoActive(DENTRO), true);
  assert.equal(webPromoActive(ANTES), false);
  assert.equal(webPromoActive(DESPUES), false);
  assert.equal(webPromoActive(new Date(WEB_PROMO.startsAt)), true);
  assert.equal(webPromoActive(new Date(WEB_PROMO.endsAt)), true);
});

test('WEB_PROMO_OFF=1 corta la promo aunque la ventana esté vigente', () => {
  assert.equal(webPromoActive(DENTRO, { WEB_PROMO_OFF: '1' }), false);
  assert.equal(webPromoActive(DENTRO, { WEB_PROMO_OFF: '0' }), true);
});

test('porcentaje o fechas inválidos dejan la promo apagada', () => {
  const base = { percent: 15, startsAt: WEB_PROMO.startsAt, endsAt: WEB_PROMO.endsAt };
  assert.equal(webPromoActive(DENTRO, {}, { ...base, percent: 0 }), false);
  assert.equal(webPromoActive(DENTRO, {}, { ...base, percent: 100 }), false);
  assert.equal(webPromoActive(DENTRO, {}, { ...base, percent: 'x' }), false);
  assert.equal(webPromoActive(DENTRO, {}, { ...base, startsAt: 'no-es-fecha' }), false);
});

test('el precio rebajado se redondea a entero y nunca baja de 1', () => {
  assert.equal(applyPromoToPrice(1234), 1049);
  assert.equal(applyPromoToPrice(1000), 850);
  assert.equal(applyPromoToPrice(1), 1);
  assert.equal(applyPromoToPrice(0), 0);
  assert.equal(applyPromoToPrice(null), null);
});

test('rebaja solo activas con precio válido y conserva el precio original', () => {
  const out = applyWebPromoToItems(items(), { now: DENTRO });
  assert.equal(out[0].price, 1049);
  assert.equal(out[0].original_price, 1234);
  assert.equal(out[1].price, 55);
  assert.equal(out[2].price, 900);
  assert.equal(out[2].original_price, undefined);
  assert.equal(out[3].price, null);
});

test('no muta la lista original y fuera de ventana devuelve la misma referencia', () => {
  const original = items();
  applyWebPromoToItems(original, { now: DENTRO });
  assert.equal(original[0].price, 1234);
  assert.equal(applyWebPromoToItems(original, { now: DESPUES }), original);
  assert.equal(applyWebPromoToItems(original, { now: DENTRO, env: { WEB_PROMO_OFF: '1' } }), original);
});

test('applyWebPromoToCatalog respeta la forma { items } y entradas inválidas', () => {
  const catalog = { updated_at: 'x', items: items() };
  const out = applyWebPromoToCatalog(catalog, { now: DENTRO });
  assert.equal(out.updated_at, 'x');
  assert.equal(out.items[0].price, 1049);
  assert.equal(applyWebPromoToCatalog(null, { now: DENTRO }), null);
  assert.deepEqual(applyWebPromoToCatalog({ foo: 1 }, { now: DENTRO }), { foo: 1 });
});

test('el carrito valida contra el precio rebajado y avisa del cambio al cliente con precio viejo', () => {
  const catalogo = applyWebPromoToItems(items(), { now: DENTRO });
  const [conPrecioViejo] = validateCartAgainstCatalog(
    [{ product_id: 'MLU1', quantity: 1, unit_price_uyu: 1234 }],
    catalogo,
  );
  assert.equal(conPrecioViejo.price_uyu, 1049);
  assert.equal(conPrecioViejo.status, 'precio_cambiado');
  const [conPrecioNuevo] = validateCartAgainstCatalog(
    [{ product_id: 'MLU1', quantity: 1, unit_price_uyu: 1049 }],
    catalogo,
  );
  assert.equal(conPrecioNuevo.status, 'ok');
});

// ─── Límites de ventana y zona horaria (Uruguay, UTC-3 fijo, sin horario de verano) ───

import {
  promoBannerScript,
  promoAwareCacheControl,
  promoEndGuardScript,
  promoWasHtml,
  secondsToNextPromoBoundary,
  webPromoState,
} from '../_shared/web-promo.js';
import {
  buildSnapshot,
  calculateTotals,
  calculateTransferTotals,
} from '../api/_orders_logic.js';
import { fetchCatalog, CATALOG_URL } from '../_shared/catalog.js';

test('inicio y fin exactos en hora de Montevideo, expresados en UTC', () => {
  // 00:00 del 1/11 en Montevideo = 03:00 UTC
  assert.equal(webPromoActive(new Date('2026-11-01T02:59:59Z')), false);
  assert.equal(webPromoActive(new Date('2026-11-01T03:00:00Z')), true);
  // 23:59:59 del 9/11 en Montevideo = 02:59:59 UTC del 10/11
  assert.equal(webPromoActive(new Date('2026-11-10T02:59:59Z')), true);
  assert.equal(webPromoActive(new Date('2026-11-10T03:00:00Z')), false);
});

test('el servidor del usuario en otra zona horaria no cambia la ventana', () => {
  // 9/11 23:59:59 en Montevideo (UTC-3) es la misma instantánea que 10/11 02:59:59 UTC
  // y que 9/11 20:59:59 en Ciudad de México (UTC-6).
  assert.equal(webPromoActive(new Date('2026-11-09T20:59:59-06:00')), true);
  assert.equal(webPromoActive(new Date('2026-11-09T21:00:00-06:00')), false);
});

test('al terminar la ventana el precio vuelve exactamente al habitual', () => {
  const catalogo = [{ id: 'MLU1', price: 2450, status: 'active', available_quantity: 1 }];
  const dentro = applyWebPromoToItems(catalogo, { now: new Date('2026-11-10T02:59:59Z') });
  const fuera = applyWebPromoToItems(catalogo, { now: new Date('2026-11-10T03:00:00Z') });
  assert.equal(dentro[0].price, 2083);
  assert.equal(fuera[0].price, 2450);
  assert.equal(fuera[0].original_price, undefined);
});

test('estado público de la promo para la home estática', () => {
  assert.deepEqual(webPromoState(new Date('2026-11-02T12:00:00-03:00')), {
    active: true,
    name: 'Amado Week',
    percent: 15,
    starts_at: WEB_PROMO.startsAt,
    ends_at: WEB_PROMO.endsAt,
    end_label: '9/11',
  });
  assert.equal(webPromoState(new Date('2026-11-10T03:00:00Z')).active, false);
  assert.equal(webPromoState(new Date('2026-11-02T12:00:00-03:00'), { WEB_PROMO_OFF: '1' }).active, false);
});

// ─── Redondeos y acumulación 15 % + 12 % ───

test('el redondeo nunca sube el precio y se desvía a lo sumo medio peso del 15 % exacto', () => {
  for (let price = 100; price <= 30000; price++) {
    const promo = applyPromoToPrice(price);
    assert.ok(promo <= price);
    assert.ok(Math.abs(promo - price * 0.85) <= 0.5 + 1e-9, `precio ${price}: promo ${promo}`);
  }
});

test('acumulación: transferencia = 12 % sobre el precio ya rebajado, sin tercera rebaja', () => {
  let maximo = 0;
  for (let price = 100; price <= 30000; price++) {
    const promo = applyPromoToPrice(price);
    const { transferProductsTotal } = calculateTransferTotals({
      productsTotal: promo, pickupDiscount: 0, shippingCost: 0,
    });
    assert.equal(transferProductsTotal, Math.round(promo * 0.88));
    const rebajaTotal = (price - transferProductsTotal) / price;
    maximo = Math.max(maximo, rebajaTotal);
    // 1 - 0,85 x 0,88 = 25,2 %; los dos redondeos suman menos de 1 peso de desvío
    assert.ok(rebajaTotal <= 0.252 + 1 / price, `precio ${price}: rebaja total ${rebajaTotal}`);
  }
  assert.ok(maximo >= 0.251);
});

test('caso Aulagnier MLU1525417286: habitual 2.450, promo 2.083, transferencia 1.833', () => {
  const [item] = applyWebPromoToItems(
    [{ id: 'MLU1525417286', title: 'Aulagnier', price: 2450, status: 'active', available_quantity: 2 }],
    { now: DENTRO },
  );
  assert.equal(item.original_price, 2450);
  assert.equal(item.price, 2083);
  assert.equal(Math.round(item.price * 0.88), 1833);
  assert.match(promoWasHtml(item), /Precio habitual: <s>\$2\.450 UYU<\/s>/);
  assert.match(promoWasHtml(item), /Amado Week: 15% menos hasta el 9\/11/);
});

test('promoWasHtml queda vacío sin promo, en pausadas y sin precio habitual', () => {
  assert.equal(promoWasHtml({ price: 2450 }), '');
  assert.equal(promoWasHtml({ price: 2083, original_price: 2083 }), '');
  assert.equal(promoWasHtml({ price: 0, original_price: 2450 }), '');
  assert.equal(promoWasHtml(null), '');
});

// ─── No se descuenta dos veces ───

test('aplicar la promo dos veces sobre el mismo catálogo da el mismo precio', () => {
  const una = applyWebPromoToItems(items(), { now: DENTRO });
  const dos = applyWebPromoToItems(una, { now: DENTRO });
  assert.deepEqual(dos, una);
  assert.equal(dos[0].price, 1049);
});

test('pedido de 2 unidades: el servidor cobra 2 x precio promo, sin rebajar de nuevo', () => {
  const catalogo = applyWebPromoToItems(
    [{ id: 'MLU1525417286', title: 'Aulagnier', price: 2450, status: 'active', available_quantity: 5 }],
    { now: DENTRO },
  );
  const { snapshot, errors } = buildSnapshot([{ product_id: 'MLU1525417286', quantity: 2 }], catalogo);
  assert.deepEqual(errors, []);
  assert.equal(snapshot[0].unit_price_uyu, 2083);
  assert.equal(snapshot[0].line_total_uyu, 4166);
  const retiro = calculateTotals(snapshot, 'pickup');
  assert.equal(retiro.productsTotal, 4166);
  assert.equal(retiro.pickupDiscount, 150);
  assert.equal(retiro.payableTotal, 4016);
  const transferencia = calculateTransferTotals(retiro);
  assert.equal(transferencia.transferProductsTotal, Math.round(4166 * 0.88));
  assert.equal(transferencia.transferPayableTotal, Math.round(4166 * 0.88) - 150);
});

test('el envío gratis y el retiro se evalúan sobre el total ya rebajado', () => {
  const [item] = applyWebPromoToItems(
    [{ id: 'MLU9', title: 'Libro', price: 1700, status: 'active', available_quantity: 1 }],
    { now: DENTRO },
  );
  assert.equal(item.price, 1445);
  const { snapshot } = buildSnapshot([{ product_id: 'MLU9', quantity: 1 }], [item]);
  assert.equal(calculateTotals(snapshot, 'shipping').shippingCost, 250);
});

// ─── Caché: el catálogo crudo se cachea, la promo se decide en cada request ───

test('el mismo catálogo cacheado cambia de precio al cruzar el fin de la ventana', async (t) => {
  const previousFetch = globalThis.fetch;
  const previousCaches = globalThis.caches;
  const crudo = { items: [{ id: 'MLU1', title: 'Uno', price: 2450, status: 'active', available_quantity: 1 }] };
  const cache = new Map();
  let descargas = 0;
  globalThis.caches = { default: {
    async match(key) { return cache.get(key.url)?.clone() || null; },
    async put(key, response) { cache.set(key.url, response.clone()); },
  } };
  globalThis.fetch = async () => { descargas++; return Response.json(crudo); };
  const pending = [];
  const ctx = { env: { APP_ENV: 'production' }, waitUntil(p) { pending.push(p); } };
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-10T02:59:59Z').getTime() });
  try {
    const dentro = await fetchCatalog(ctx);
    await Promise.all(pending);
    assert.equal(dentro.items[0].price, 2083);
    assert.ok(cache.has(CATALOG_URL));
    assert.equal((await cache.get(CATALOG_URL).clone().json()).items[0].price, 2450, 'la caché guarda el precio crudo');

    t.mock.timers.setTime(new Date('2026-11-10T03:00:00Z').getTime());
    const fuera = await fetchCatalog(ctx);
    assert.equal(fuera.items[0].price, 2450);
    assert.equal(fuera.items[0].original_price, undefined);
    assert.equal(descargas, 1, 'sin nueva descarga: cambió el precio sin tocar la caché');
  } finally {
    t.mock.timers.reset();
    globalThis.fetch = previousFetch;
    globalThis.caches = previousCaches;
  }
});

test('el TTL de las páginas con precio se recorta para vencer cuando cambia el precio', () => {
  assert.equal(secondsToNextPromoBoundary(new Date('2026-11-09T23:59:00-03:00')), 60);
  assert.equal(promoAwareCacheControl(3600, new Date('2026-11-09T23:59:00-03:00')), 'public, max-age=60');
  assert.equal(promoAwareCacheControl(300, new Date('2026-11-02T12:00:00-03:00')), 'public, max-age=300');
  assert.equal(promoAwareCacheControl(3600, new Date('2026-10-31T23:30:00-03:00')), 'public, max-age=1800');
  assert.equal(promoAwareCacheControl(3600, new Date('2026-11-11T12:00:00-03:00')), 'public, max-age=3600');
  assert.equal(secondsToNextPromoBoundary(new Date('2026-11-11T12:00:00-03:00')), null);
  assert.equal(
    promoAwareCacheControl(3600, new Date('2026-11-09T23:59:00-03:00'), { WEB_PROMO_OFF: '1' }),
    'public, max-age=3600',
  );
});

test('el guard de fin de promo solo recarga páginas con precio promocional y una vez', () => {
  const script = promoEndGuardScript();
  assert.match(script, /promo-was/);
  assert.match(script, /sessionStorage/);
  assert.ok(script.includes(String(Date.parse(WEB_PROMO.endsAt))));
});

test('el banner de campaña dice Amado Week, el 9/11 y la transferencia, y se apaga al fin', () => {
  const script = promoBannerScript();
  assert.match(script, /AMADO WEEK · 15% menos hasta el 9\/11 · 12% adicional pagando por transferencia/);
  assert.ok(script.includes(`Date.now()>${Date.parse(WEB_PROMO.endsAt)}`));
  assert.match(script, /announcement-bar/);
});
