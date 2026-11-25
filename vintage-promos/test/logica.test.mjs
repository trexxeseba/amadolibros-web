import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { crearPisoDe, origenDe } from '../src/costos.mjs';
import { vintageCompetitivePolicy } from '../../worker-sync/vintage-pricing.js';
import { maniobra, tramoDe, aguantaPct, aguantaMonto, resumenMargen, evaluarEntrada, resumenCampana, armarResumen } from '../src/logica.mjs';

test('maniobra: lo que sobra entre el precio y el piso', () => {
  assert.deepEqual(maniobra({ precio: 2000, piso: 1600 }), { pesos: 400, pct: 0.2 });
  assert.deepEqual(maniobra({ precio: 1600, piso: 1600 }), { pesos: 0, pct: 0 });
  assert.equal(maniobra({ precio: 2000, piso: null }), null);
  assert.equal(maniobra({ precio: 0, piso: 1000 }), null);
  // Si el piso quedó por encima del precio (precio mal cargado) no hay maniobra negativa.
  assert.equal(maniobra({ precio: 1500, piso: 1600 }).pesos, 0);
});

test('tramos por porcentaje de maniobra', () => {
  assert.equal(tramoDe(0).clave, 'menos_de_3');
  assert.equal(tramoDe(0.03).clave, '3_a_7');
  assert.equal(tramoDe(0.1).clave, '7_a_12');
  assert.equal(tramoDe(0.5).clave, '12_o_mas');
});

test('aguanta un descuento o un cupón sólo si el precio final no pisa el piso', () => {
  assert.equal(aguantaPct({ precio: 2000, piso: 1800 }, 10), true);   // 1800 justo
  assert.equal(aguantaPct({ precio: 2000, piso: 1801 }, 10), false);
  assert.equal(aguantaMonto({ precio: 2000, piso: 1700 }, 300), true);
  assert.equal(aguantaMonto({ precio: 2000, piso: 1701 }, 300), false);
  assert.equal(aguantaPct({ precio: 2000, piso: null }, 5), false);
});

test('resumenMargen separa sin costo, con descuento a la vista y medibles', () => {
  const r = resumenMargen([
    { id: 'A', precio: 2000, piso: 1600, conDescuento: false },   // 20 %
    { id: 'B', precio: 1600, piso: 1600, conDescuento: false },   // 0 %
    { id: 'C', precio: 2000, piso: null, conDescuento: false },   // sin costo
    { id: 'D', precio: 1800, piso: 1000, conDescuento: true },    // ya con promo
  ]);
  assert.equal(r.total, 4);
  assert.equal(r.medibles, 2);
  assert.equal(r.sin_piso, 1);
  assert.equal(r.ya_con_descuento, 1);
  assert.equal(r.tramos.menos_de_3, 1);
  assert.equal(r.tramos['12_o_mas'], 1);
  assert.equal(r.aguantan_descuento['15%'], 1);
  assert.equal(r.aguantan_descuento['20%'], 1);
  assert.equal(r.aguantan_cupon['$300'], 1);  // 2000 - 300 = 1700 >= 1600
  assert.equal(r.aguantan_cupon['$500'], 0);  // 2000 - 500 = 1500 < 1600
});

test('campaña de vendedor: entra si el precio con MENOR descuento aguanta el piso', () => {
  const promo = { id: 'P1', type: 'SELLER_CAMPAIGN' };
  const ok = evaluarEntrada({ promo, entrada: { min_discounted_price: 1200, max_discounted_price: 1900, suggested_discounted_price: 1400 }, precio: 2000, piso: 1800 });
  assert.equal(ok.estado, 'entra'); assert.equal(ok.precioFinal, 1900); assert.equal(ok.descuentoPct, 5);
  const no = evaluarEntrada({ promo, entrada: { max_discounted_price: 1700 }, precio: 2000, piso: 1800 });
  assert.equal(no.estado, 'no_entra');
});

test('campaña Smart: el precio fijado por Mercado Libre manda', () => {
  const promo = { id: 'P2', type: 'SMART' };
  assert.equal(evaluarEntrada({ promo, entrada: { price: 1750 }, precio: 2000, piso: 1800 }).estado, 'no_entra');
  assert.equal(evaluarEntrada({ promo, entrada: { price: 1800 }, precio: 2000, piso: 1800 }).estado, 'entra');
});

test('volumen y cupón de monto fijo', () => {
  assert.equal(evaluarEntrada({ promo: { type: 'VOLUME' }, entrada: { discount_percentage: 10 }, precio: 2000, piso: 1800 }).estado, 'entra');
  assert.equal(evaluarEntrada({ promo: { type: 'VOLUME' }, entrada: { discount_percentage: 11 }, precio: 2000, piso: 1800 }).estado, 'no_entra');
  assert.equal(evaluarEntrada({ promo: { type: 'SELLER_COUPON_CAMPAIGN' }, entrada: { fixed_amount: 200 }, precio: 2000, piso: 1800 }).estado, 'entra');
  assert.equal(evaluarEntrada({ promo: { type: 'SELLER_COUPON_CAMPAIGN' }, entrada: { fixed_amount: 201 }, precio: 2000, piso: 1800 }).estado, 'no_entra');
});

test('sin costo conocido o sin datos nunca figura como "entra"', () => {
  assert.equal(evaluarEntrada({ promo: { type: 'SMART' }, entrada: { price: 100 }, precio: 2000, piso: null }).estado, 'sin_piso');
  assert.equal(evaluarEntrada({ promo: { type: 'DEAL' }, entrada: {}, precio: 2000, piso: 1800 }).estado, 'sin_datos');
  assert.equal(evaluarEntrada({ promo: { type: 'DEAL' }, entrada: { price: 0, max_discounted_price: 1900 }, precio: 0, piso: 1800 }).estado, 'sin_datos');
});

test('el resumen de texto lleva agregados y ningún costo ni piso de un libro', () => {
  const margen = resumenMargen([{ id: 'MLU123', precio: 2000, piso: 1634, conDescuento: false }]);
  const camp = resumenCampana({ id: 'P1', type: 'SMART', status: 'started', name: 'Smart' }, [{ estado: 'entra' }, { estado: 'fuera_de_muestra' }]);
  const t = armarResumen({ fecha: '2026-11-19', cuenta: '2341378249', pisos: { lista_sbs: '2026-11-19', dias_lista: 0.4, lista_vigente: true }, margen, campanas: [camp] });
  assert.match(t, /Solo lectura/);
  assert.match(t, /entran 1/);
  assert.ok(!t.includes('MLU123') && !t.includes('1634'));
});

const POLITICA = { supplierDiscount: 0.25, arsPerUyu: 40, usdPerUyu: 0.025, freightUsdKg: 20, laborUyu: 50, margin: 0.35, mlFee: 0.17, deliveryUyu: 100, minimumContributionUyu: 100, minimumSaleUyu: 1600, roundUyu: 10, availabilityDays: 18, additionalPricePct: 0, listingTypeId: 'gold_special', competitive: true, competitiveFloorMargin: 0.18, competitiveMinimumSaleUyu: 1200, competitiveBelowFloor: 'full' };

test('crearPisoDe: piso de un libro de SBS, null si no tiene renglón o SKU de SBS', () => {
  const filas = new Map([['9789500000001', { isbn: '9789500000001', title: 'X', listArs: 40000, weightKg: 0.4, stock: '5' }]]);
  const pisoDe = crearPisoDe(filas, vintageCompetitivePolicy(POLITICA));
  const piso = pisoDe({ seller_custom_field: 'AMADO-AR-9789500000001' });
  assert.ok(piso >= 1200 && piso < 5000, `piso ${piso}`);
  assert.equal(pisoDe({ seller_custom_field: 'AMADO-AR-9789500000002' }), null);
  assert.equal(pisoDe({ seller_custom_field: 'ARNOIA-9789500000001' }), null);
  assert.equal(pisoDe({}), null);
});

test('origenDe clasifica por SKU', () => {
  assert.equal(origenDe({ seller_custom_field: 'AMADO-AR-9789500000001' }), 'sbs');
  assert.equal(origenDe({ seller_custom_field: 'ARNOIA-978' }), 'arnoia');
  assert.equal(origenDe({ seller_custom_field: 'HERMES-MLU1' }), 'hermes');
  assert.equal(origenDe({}), 'otro');
});

test('el informe es de solo lectura y vive en Vintage', () => {
  const src = fs.readFileSync(new URL('../src/informe.mjs', import.meta.url), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  assert.ok(!/\.(put|post|delete|patch)\(/.test(src), 'el informe no puede escribir');
  assert.match(src, /await exigirVintage\(ml\)/);
  assert.ok(!src.includes('440298103') && !/CUENTAS\s*(\.\s*libros|\[\s*['"]libros)/.test(src));
});
