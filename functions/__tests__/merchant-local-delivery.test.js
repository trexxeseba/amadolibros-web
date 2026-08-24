// MERCHANT-LOCAL-DELIVERY-1 — el feed debe declarar la entrega en el día en
// Montevideo con EXACTAMENTE los mismos importes que cobra el checkout real.
// Un feed que promete un envío más barato que el checkout es causa de
// desaprobación en Merchant, y antes que eso es una promesa falsa al
// comprador.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  itemShippingCostUyu,
  shippingTags,
  MONTEVIDEO_REGION,
  MONTEVIDEO_SERVICE,
  SHIPPING_COUNTRY,
} from '../_shared/merchant-delivery.js';
import { FREE_SHIPPING_THRESHOLD, SHIPPING_COST } from '../api/_orders_logic.js';
import { renderFeedItem } from '../feed.xml.js';

const baseItem = {
  id: 'MLU123456789',
  title: 'Tarot de Marsella con guía',
  price: 990,
  currency: 'UYU',
  available_quantity: 2,
  condition: 'new',
  isbn: '9788428543231',
  thumbnail: 'https://http2.mlstatic.com/D_ABC-O.jpg',
  pictures: ['https://http2.mlstatic.com/D_ABC-O.jpg'],
};

// ── 1. El costo declarado es el que cobra el checkout ──────────────────────

test('1. bajo el umbral se declara el costo real de envío del checkout', () => {
  assert.equal(itemShippingCostUyu(FREE_SHIPPING_THRESHOLD - 1), SHIPPING_COST);
  assert.equal(itemShippingCostUyu(990), SHIPPING_COST);
});

test('1b. desde el umbral inclusive el envío es gratis, igual que en el checkout', () => {
  assert.equal(itemShippingCostUyu(FREE_SHIPPING_THRESHOLD), 0);
  assert.equal(itemShippingCostUyu(FREE_SHIPPING_THRESHOLD + 500), 0);
});

test('1c. un precio inválido nunca promete envío gratis (falla del lado seguro)', () => {
  assert.equal(itemShippingCostUyu(undefined), SHIPPING_COST);
  assert.equal(itemShippingCostUyu(null), SHIPPING_COST);
  assert.equal(itemShippingCostUyu('no-es-un-precio'), SHIPPING_COST);
  assert.equal(itemShippingCostUyu(-100), SHIPPING_COST);
});

// ── 2. Montevideo queda declarado como entrega en el día ───────────────────

test('2. se emite una entrada de Montevideo con handling y tránsito en 0 (mismo día)', () => {
  const xml = shippingTags({ price: 990 });
  assert.match(xml, new RegExp(`<g:region>${MONTEVIDEO_REGION}</g:region>`));
  assert.match(xml, new RegExp(`<g:service>${MONTEVIDEO_SERVICE}</g:service>`));
  assert.match(xml, /<g:max_handling_time>0<\/g:max_handling_time>/);
  assert.match(xml, /<g:max_transit_time>0<\/g:max_transit_time>/);
});

test('2b. el país declarado es Uruguay', () => {
  assert.match(shippingTags({ price: 990 }), new RegExp(`<g:country>${SHIPPING_COUNTRY}</g:country>`));
});

// ── 3. El resto del país no declara plazos que no podemos garantizar ───────

test('3. se emiten dos entradas: Montevideo con tiempos y nacional sin tiempos', () => {
  const xml = shippingTags({ price: 990 });
  const bloques = xml.match(/<g:shipping>/g) || [];
  assert.equal(bloques.length, 2, 'debe haber exactamente dos bloques de envío');
  // Sólo el bloque de Montevideo declara tiempos.
  assert.equal((xml.match(/<g:max_transit_time>/g) || []).length, 1);
  assert.equal((xml.match(/<g:region>/g) || []).length, 1);
});

// ── 4. Integración real con el feed ────────────────────────────────────────

test('4. renderFeedItem incluye los bloques de envío con el precio correcto', () => {
  const xml = renderFeedItem(baseItem);
  assert.match(xml, /<g:shipping>/);
  assert.match(xml, new RegExp(`<g:price>${SHIPPING_COST} UYU</g:price>`));
  assert.match(xml, new RegExp(`<g:region>${MONTEVIDEO_REGION}</g:region>`));
});

test('4b. un ítem caro declara envío gratis en el feed', () => {
  const xml = renderFeedItem({ ...baseItem, price: FREE_SHIPPING_THRESHOLD + 100 });
  assert.match(xml, /<g:price>0 UYU<\/g:price>/);
});

test('4c. el feed sigue emitiendo los atributos que ya tenía (sin regresión)', () => {
  const xml = renderFeedItem(baseItem);
  for (const tag of ['g:id', 'g:title', 'g:description', 'g:link', 'g:availability', 'g:condition']) {
    assert.match(xml, new RegExp(`<${tag}>`), `falta ${tag}`);
  }
  // El precio del producto sigue intacto y no se confunde con el del envío.
  assert.match(xml, /<g:price>990 UYU<\/g:price>/);
});

// ── 5. Idempotencia ────────────────────────────────────────────────────────

test('5. shippingTags es puro: mismo ítem, misma salida', () => {
  assert.equal(shippingTags({ price: 990 }), shippingTags({ price: 990 }));
});
