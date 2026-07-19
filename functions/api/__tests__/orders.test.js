import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateBody,
  calculateTotals,
  validateCartAgainstCatalog,
  generatePublicCode,
  RETIRO_DISCOUNT,
  SHIPPING_COST,
  FREE_SHIPPING_THRESHOLD,
} from '../_orders_logic.js';

// ── validateBody ─────────────────────────────────────────────────────────────

test('validateBody: body nulo → error', () => {
  assert.notEqual(validateBody(null), null);
});

test('validateBody: idempotency_key ausente → error', () => {
  assert.notEqual(
    validateBody({ items: [{ id: 'x', price: 100, quantity: 1 }], delivery_type: 'pickup' }),
    null
  );
});

test('validateBody: items vacío → error', () => {
  assert.notEqual(
    validateBody({ idempotency_key: 'k', items: [], delivery_type: 'pickup' }),
    null
  );
});

test('validateBody: delivery_type inválido → error', () => {
  assert.notEqual(
    validateBody({ idempotency_key: 'k', items: [{ id: 'x', price: 100, quantity: 1 }], delivery_type: 'drone' }),
    null
  );
});

test('validateBody: envío sin address → error', () => {
  assert.notEqual(
    validateBody({
      idempotency_key: 'k',
      items: [{ id: 'x', price: 100, quantity: 1 }],
      delivery_type: 'shipping',
      delivery_departamento: 'Montevideo',
    }),
    null
  );
});

test('validateBody: envío sin departamento → error', () => {
  assert.notEqual(
    validateBody({
      idempotency_key: 'k',
      items: [{ id: 'x', price: 100, quantity: 1 }],
      delivery_type: 'shipping',
      delivery_address: 'Av. 18 de Julio 1360',
    }),
    null
  );
});

test('validateBody: pickup válido → sin error', () => {
  assert.equal(
    validateBody({
      idempotency_key: 'abc-123',
      items: [{ id: 'MLU1', price: 500, quantity: 2 }],
      delivery_type: 'pickup',
    }),
    null
  );
});

// ── calculateTotals ───────────────────────────────────────────────────────────

test('calculateTotals: pickup subtotal=1000 → descuento=150, total=850', () => {
  const r = calculateTotals([{ price: 1000, quantity: 1 }], 'pickup');
  assert.equal(r.subtotal, 1000);
  assert.equal(r.discount, RETIRO_DISCOUNT);
  assert.equal(r.shipping, 0);
  assert.equal(r.total, 850);
});

test('calculateTotals: pickup subtotal menor que descuento → total=0', () => {
  const r = calculateTotals([{ price: 50, quantity: 1 }], 'pickup');
  assert.equal(r.subtotal, 50);
  assert.equal(r.discount, 50);
  assert.equal(r.total, 0);
});

test('calculateTotals: envío subtotal=1999 → shipping=250', () => {
  const r = calculateTotals([{ price: 1999, quantity: 1 }], 'shipping');
  assert.equal(r.shipping, SHIPPING_COST);
  assert.equal(r.total, 1999 + SHIPPING_COST);
  assert.equal(r.discount, 0);
});

test('calculateTotals: envío subtotal=2000 → shipping=0 (envío gratis)', () => {
  const r = calculateTotals([{ price: 2000, quantity: 1 }], 'shipping');
  assert.equal(r.shipping, 0);
  assert.equal(r.total, 2000);
});

// ── validateCartAgainstCatalog ────────────────────────────────────────────────

test('validateCartAgainstCatalog: producto desconocido → error "no encontrado"', () => {
  const errors = validateCartAgainstCatalog(
    [{ id: 'UNKNOWN', price: 100, quantity: 1 }],
    [{ id: 'MLU1', price: 100, available_quantity: 5 }]
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /no encontrado/i);
});

test('validateCartAgainstCatalog: precio incorrecto → error "precio"', () => {
  const errors = validateCartAgainstCatalog(
    [{ id: 'MLU1', price: 999, quantity: 1 }],
    [{ id: 'MLU1', price: 500, available_quantity: 5 }]
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /precio/i);
});

// ── generatePublicCode ────────────────────────────────────────────────────────

test('generatePublicCode: formato AL-YYMMDD-XXXXXX con fecha fija', () => {
  const code = generatePublicCode(new Date('2026-07-19T12:00:00Z'));
  assert.match(code, /^AL-260719-[A-Z0-9]{6}$/);
});
