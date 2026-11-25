import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cotizarDesdeCostos, eanDeSku } from '../src/costos-proveedores.mjs';
import { vintageCompetitivePolicy } from '../../worker-sync/vintage-pricing.js';

const politica = vintageCompetitivePolicy({ supplierDiscount: 0.3, arsPerUyu: 30, usdPerUyu: 40, freightUsdKg: 12, laborUyu: 100, margin: 0.3, mlFee: 0.17,
  deliveryUyu: 230, minimumContributionUyu: 300, minimumSaleUyu: 1600, roundUyu: 10, availabilityDays: 20, listingTypeId: 'gold_special' });
const ahora = Date.parse('2026-11-22T12:00:00Z');
const lista = { fecha: '2026-11-22', cotizacion: { eur_uyu: 47 }, flete_usd_kg: 16, iva_en_costo: true,
  libros: { '9788423370504': { costo_eur: 17.96, iva: 4, peso_g: 1308 }, '9780000000001': { costo_eur: 0 } } };

test('Arnoia: costo con IVA, euro y flete de España; piso y precio de lista con la fórmula del publicador', () => {
  const c = cotizarDesdeCostos(lista, '9788423370504', politica, ahora);
  const libro = 17.96 * 1.04 * 47, flete = 1.308 * 16 * 40;
  assert.ok(Math.abs(c.completo.book - libro) < 1e-6);
  assert.ok(Math.abs(c.completo.freight - flete) < 1e-6);
  assert.ok(Math.abs(c.completo.cost - (libro + flete + 100 + 230)) < 1e-6);
  assert.ok(c.piso_18 >= 1200 && c.piso_18 <= c.completo.price);
  // El piso deja al menos 18 % sobre el costo base (como en SBS).
  assert.ok(c.piso_18 * (1 - 0.17) - c.completo.cost > 0);
});

test('sin costo, sin el libro o con lista vieja: no cotiza', () => {
  assert.equal(cotizarDesdeCostos(lista, '9780000000001', politica, ahora), null);
  assert.equal(cotizarDesdeCostos(lista, '9789999999999', politica, ahora), null);
  assert.equal(cotizarDesdeCostos(null, '9788423370504', politica, ahora), null);
  assert.equal(cotizarDesdeCostos({ ...lista, fecha: '2026-09-01' }, '9788423370504', politica, ahora), null);
});

test('EAN desde el SKU', () => {
  assert.equal(eanDeSku('ARNOIA-9788423370504', 'ARNOIA'), '9788423370504');
  assert.equal(eanDeSku('AMADO-AR-9788423370504', 'ARNOIA'), null);
  assert.equal(eanDeSku(undefined, 'ARNOIA'), null);
});

test('GTIN de la publicación', async () => {
  const { gtinDe } = await import('../src/publicaciones.mjs');
  assert.equal(gtinDe({ attributes: [{ id: 'GTIN', value_name: '9788423370504' }] }), '9788423370504');
  assert.equal(gtinDe({ attributes: [{ id: 'GTIN', value_name: '978-84-233-7050-4, 8423370500' }] }), '9788423370504');
  assert.equal(gtinDe({ attributes: [] }), null);
  assert.equal(gtinDe({}), null);
});

test('publicaciones de Arnoia en catálogo: EAN por item_id', async () => {
  const { arnoiaPorPublicacion } = await import('../src/costos-proveedores.mjs');
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'pg-'));
  writeFileSync(join(dir, 'publicadas-vintage.json'), JSON.stringify({
    'arnoia:9788432251436': { item_id: 'MLU1', ean: '9788432251436', fuente: 'arnoia' },
    MLU19988351: { item_id: 'MLU2', precio: 1792 },
    'glic:x': { item_id: 'MLU3', ean: '9788400000000', fuente: 'glic' },
  }));
  const m = arnoiaPorPublicacion(dir);
  assert.equal(m.size, 1);
  assert.equal(m.get('MLU1'), '9788432251436');
  assert.equal(arnoiaPorPublicacion(null).size, 0);
});

test('Arnoia y Celesa: gana el más barato disponible', async () => {
  const { mejorProveedor } = await import('../src/costos-proveedores.mjs');
  const ean = '9788423370504';
  const arn = { ...lista, libros: { [ean]: { costo_eur: 17.96, iva: 4, peso_g: 500 } } };
  const cel = { ...lista, libros: { [ean]: { costo_eur: 16.5, iva: 4, peso_g: 500 } } };
  const m = mejorProveedor({ arnoia: arn, celesa: cel }, ean, politica, ahora);
  assert.equal(m.proveedor, 'celesa');
  assert.ok(m.alternativas.arnoia > m.alternativas.celesa);
  // Celesa más barata pero sin stock: va Arnoia.
  const celSin = { ...cel, libros: { [ean]: { ...cel.libros[ean], disponible: false } } };
  assert.equal(mejorProveedor({ arnoia: arn, celesa: celSin }, ean, politica, ahora).proveedor, 'arnoia');
  // Sólo en una lista.
  assert.equal(mejorProveedor({ arnoia: arn }, ean, politica, ahora).proveedor, 'arnoia');
  assert.equal(mejorProveedor({ arnoia: arn, celesa: cel }, '9789999999999', politica, ahora), null);
  assert.equal(mejorProveedor({}, ean, politica, ahora), null);
});
