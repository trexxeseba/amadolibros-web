import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  LIMITES, modoDeEscritura, descuentoPct, cuponVigente, esLibroMedico, clasificarCompetencia, exclusiones,
  esPromoProhibida, esNombreAmadoWeek, evaluarEscritura, evaluarLightning, verificarPostEscritura, filaAlerta,
} from '../src/guardas.mjs';

const config = JSON.parse(readFileSync(new URL('../config/exclusiones.json', import.meta.url), 'utf8'));
const AHORA = new Date('2026-11-10T12:00:00Z');

// Ítem sano: 5 unidades, alta en 2020, título común, compite en catálogo.
const item = (o = {}) => ({ id: 'MLU100', title: 'Libro La Sombra Del Viento', available_quantity: 5, date_created: '2020-11-13T14:09:26.000Z', ...o });
const base = (o = {}) => ({
  modo: 'real', ahora: AHORA, config, item: item(),
  venta: { amount: 1300, regular_amount: null },
  promo: { id: 'C-MLU1', type: 'SELLER_CAMPAIGN', name: 'Amado 15', price: 1150, seller_percentage: 11.5 },
  cupon: { monto: 0 }, competencia: { status: 'competing' }, ...o,
});
const guardas = r => r.fallas.map(f => f.guarda).sort();

test('modo: el default es prueba; real solo con AGENTES_ML_MODO=real; el interruptor y el dry_run mandan', () => {
  assert.equal(modoDeEscritura({}), 'prueba');
  assert.equal(modoDeEscritura({ AGENTES_ML_MODO: 'real' }), 'real');
  assert.equal(modoDeEscritura({ AGENTES_ML_MODO: 'REAL', AGENTES_ML_DRY_RUN: 'true' }), 'prueba');
  assert.equal(modoDeEscritura({ AGENTES_ML_MODO: 'real', AGENTES_ML_SOLO_LECTURA: 'true' }), 'solo_lectura');
  assert.equal(modoDeEscritura({ AGENTES_ML_MODO: 'cualquier cosa' }), 'prueba');
});

test('un ítem sano con un descuento chico pasa todas las guardas', () => {
  const r = evaluarEscritura('unirse_promo', base());
  assert.deepEqual(r, { permitido: true, fallas: [], alerta: false });
});

test('descuento a cargo nuestro: 15 % pasa, más de 15 % frena', () => {
  assert.equal(evaluarEscritura('unirse_promo', base({ venta: { amount: 1000 }, promo: { type: 'DEAL', name: 'X', price: 850, seller_percentage: 15 } })).permitido, true);
  const r = evaluarEscritura('unirse_promo', base({ promo: { type: 'DEAL', name: 'X', price: 1098, seller_percentage: 15.54 } }));
  assert.deepEqual(guardas(r), ['descuento_alto']);
  assert.equal(r.alerta, true);
  // Sin seller_percentage el total cuenta como propio.
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ promo: { type: 'DEAL', name: 'X', price: 1098 } }))), ['descuento_alto']);
});

test('precio visible: 16 % exacto pasa; 16,5 % frena aunque lo nuestro sea 14 % (el resto lo pone Mercado Libre)', () => {
  const regular = 1000;
  assert.equal(evaluarEscritura('unirse_promo', base({ venta: { amount: regular }, promo: { type: 'SMART', name: 'X', price: 840, seller_percentage: 15 } })).permitido, true);
  const r = evaluarEscritura('unirse_promo', base({ venta: { amount: 2000 }, promo: { type: 'SMART', name: 'X', price: 1670, seller_percentage: 14 } }));
  assert.deepEqual(guardas(r), ['visible_alto']);
});

test('el visible se mide contra el regular aunque el ítem ya esté en otra promo', () => {
  // Hoy 2.056 sobre regular 2.650 (22 % visible). Otra promo a 2.056 deja el mismo visible: frena.
  const r = evaluarEscritura('unirse_promo', base({ venta: { amount: 2056.4, regular_amount: 2650 }, promo: { type: 'DEAL', name: 'X', price: 2056.4, seller_percentage: 12 } }));
  assert.ok(guardas(r).includes('visible_alto'));
});

test('promo + cupón: tope de $750 por libro, con el cupón vigente', () => {
  const caro = { venta: { amount: 3650 }, promo: { type: 'SELLER_CAMPAIGN', name: 'Amado 15', price: 3102.5, seller_percentage: 15 } };
  const r = evaluarEscritura('unirse_promo', base({ ...caro, cupon: { monto: 300 } }));
  assert.deepEqual(guardas(r), ['promo_mas_cupon']);
  assert.deepEqual(r.fallas[0].detalle, { promo: 547.5, cupon: 300 });
  assert.equal(evaluarEscritura('unirse_promo', base({ ...caro, cupon: { monto: 200 } })).permitido, true);
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ ...caro, cupon: { monto: null } }))), ['cupon_no_leido']);
});

test('cupón vigente: el más alto de la API; si no se pudo leer, la fila de Airtable; si no hay, $500', () => {
  const api = [{ status: 'started', fixed_amount: 300 }, { status: 'started', fixed_amount: 500 }, { status: 'paused', fixed_amount: 900 }, { status: 'started', fixed_amount: 400 }];
  assert.deepEqual(cuponVigente({ cuponesApi: api, filaAirtable: { monto_max: 100 } }), { monto: 500, fuente: 'api' });
  assert.deepEqual(cuponVigente({ cuponesApi: [], filaAirtable: { monto_max: 100 } }), { monto: 0, fuente: 'api_sin_cupones' });
  assert.deepEqual(cuponVigente({ cuponesApi: null, filaAirtable: { monto_max: 700 } }), { monto: 700, fuente: 'airtable' });
  assert.deepEqual(cuponVigente({ cuponesApi: null, filaAirtable: null }), { monto: 500, fuente: 'por_defecto' });
  // Un cupón vigente sin monto fijo (porcentual) no se estima: cae al siguiente origen.
  assert.deepEqual(cuponVigente({ cuponesApi: [{ status: 'started', discount_percentage: 20 }], filaAirtable: null }), { monto: 500, fuente: 'por_defecto' });
});

test('nunca sube precios: una promo más cara que el precio visible de hoy frena', () => {
  const r = evaluarEscritura('unirse_promo', base({ venta: { amount: 1000, regular_amount: 1200 }, promo: { type: 'DEAL', name: 'X', price: 1100, seller_percentage: 8 } }));
  assert.deepEqual(guardas(r), ['subiria_el_precio']);
  assert.equal(r.alerta, true);
});

test('stock: con 1 o 2 no participa; con 3 sí', () => {
  for (const q of [0, 1, 2]) assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ item: item({ available_quantity: q }) }))), ['stock_bajo']);
  assert.equal(evaluarEscritura('unirse_promo', base({ item: item({ available_quantity: 3 }) })).permitido, true);
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ item: item({ available_quantity: undefined }) }))), ['stock_no_leido']);
});

test('una exclusión normal no deja alerta; un dato que no se pudo leer sí', () => {
  const stock = evaluarEscritura('unirse_promo', base({ item: item({ available_quantity: 1 }) }));
  assert.equal(stock.permitido, false); assert.equal(stock.alerta, false);
  const sinDato = evaluarEscritura('unirse_promo', base({ item: item({ available_quantity: null }) }));
  assert.equal(sinDato.alerta, true);
});

test('libros médicos: se excluyen por título, sin atrapar esoterismo ni psicoanálisis', () => {
  assert.equal(esLibroMedico('Libro - Atlas De Anatomía Humana Por Técnicas De Imagen', config), 'atlas de anatomia');
  assert.equal(esLibroMedico('Farmacología Básica Y Clínica', config), 'farmacologia');
  assert.equal(esLibroMedico('Manual De Enfermería Quirúrgica', config), 'enfermeria');
  for (const t of ['Libro Anatomía Del Espiritu - Myss, Caroline', 'Libro - Intervenciones En La Clínica Psicoanalítica Con Niño', 'Libro - Fundamentos Clínicos Del Acompañamiento Terapéutico', 'Libro La Sombra Del Viento']) assert.equal(esLibroMedico(t, config), null, t);
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ item: item({ title: 'Anatomía Humana Netter' }) }))), ['libro_medico']);
});

test('ítems con menos de 90 días desde el alta no participan; con 90 o más sí', () => {
  const dias = n => new Date(AHORA.getTime() - n * 86400000).toISOString();
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ item: item({ date_created: dias(89) }) }))), ['item_nuevo']);
  assert.equal(evaluarEscritura('unirse_promo', base({ item: item({ date_created: dias(90) }) })).permitido, true);
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ item: item({ date_created: 'basura' }) }))), ['alta_no_leida']);
});

test('lista manual de exclusión: sale del archivo editable', () => {
  const cfg = { ...config, items: ['MLU100'] };
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ config: cfg }))), ['lista_manual']);
  assert.ok(Array.isArray(config.items) && config.palabras_medicas.length > 10, 'el archivo de exclusiones se lee bien');
});

test('competencia según price_to_win: gana, comparte o no tiene competencia = fuera; sin catálogo = entra; sin lectura = bloqueo', () => {
  assert.equal(clasificarCompetencia({ status: 'winning' }), 'gana');
  assert.equal(clasificarCompetencia({ status: 'sharing_first_place' }), 'gana');
  assert.equal(clasificarCompetencia({ status: 'competing' }), 'compite');
  assert.equal(clasificarCompetencia({ status: 'not_listed', reason: ['item_not_opted_in'] }), 'sin_catalogo');
  assert.equal(clasificarCompetencia({ http: 500 }), 'no_leido');
  assert.equal(clasificarCompetencia(null), 'no_leido');
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ competencia: { status: 'winning' } }))), ['gana_el_catalogo']);
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ competencia: { status: 'listed' } }))), ['sin_competencia']);
  assert.equal(evaluarEscritura('unirse_promo', base({ competencia: { status: 'not_listed', reason: ['item_not_opted_in'] } })).permitido, true);
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ competencia: { http: 429 } }))), ['competencia_no_leida']);
});

test('nombres prohibidos: Amado Liquidacion 40/30/20 y Amado Week, en cualquier acción', () => {
  for (const n of ['Amado Liquidación 40', 'AMADO LIQUIDACION 30', 'amado  liquidacion 20 noviembre']) assert.equal(esPromoProhibida(n), true, n);
  for (const n of ['Amado Liquidacion 400', 'Amado 15', 'Liquidación 40 de otro']) assert.equal(esPromoProhibida(n), false, n);
  for (const n of ['Amado Week', 'amado  WEEK 2026']) assert.equal(esNombreAmadoWeek(n), true, n);
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ promo: { type: 'DEAL', name: 'Amado Liquidacion 40', price: 1150, seller_percentage: 11 } }))), ['promo_prohibida']);
  assert.deepEqual(guardas(evaluarEscritura('crear_campana', { modo: 'real', promo: { name: 'Amado Week', discount_pct: 10 } })), ['amado_week']);
  // Ni siquiera para sacar: esas promos no se tocan.
  assert.ok(guardas(evaluarEscritura('sacar_de_promo', { modo: 'real', item: item(), promo: { type: 'DEAL', name: 'Amado Liquidacion 30' } })).includes('promo_prohibida'));
});

test('crear una campaña: tope de 15 % y descuento conocido', () => {
  assert.equal(evaluarEscritura('crear_campana', { modo: 'real', promo: { name: 'Amado 15', discount_pct: 15 } }).permitido, true);
  assert.deepEqual(guardas(evaluarEscritura('crear_campana', { modo: 'real', promo: { name: 'Amado 16', discount_pct: 16 } })), ['descuento_alto']);
  assert.deepEqual(guardas(evaluarEscritura('crear_campana', { modo: 'real', promo: { name: 'Amado 15' } })), ['descuento_no_leido']);
});

test('DELETE siempre con promotion_type: sin tipo frena (borraría todas las ofertas del ítem)', () => {
  const ok = evaluarEscritura('sacar_de_promo', { modo: 'real', item: item(), promo: { id: 'P-1', type: 'DEAL', name: 'Ciberlunes' } });
  assert.equal(ok.permitido, true);
  const sin = evaluarEscritura('sacar_de_promo', { modo: 'real', item: item(), promo: { id: 'P-1', name: 'Ciberlunes' } });
  assert.deepEqual(guardas(sin), ['delete_sin_tipo']);
  assert.equal(sin.alerta, true);
  assert.equal(evaluarEscritura('sacar_de_promo', { modo: 'real', item: item(), request: { query: { promotion_type: 'DEAL' } } }).permitido, true);
  // Sacar no pasa por las exclusiones de stock o antigüedad: salir de una promo siempre se puede.
  assert.equal(evaluarEscritura('sacar_de_promo', { modo: 'real', item: item({ available_quantity: 1 }), promo: { type: 'DEAL', name: 'Ciberlunes' } }).permitido, true);
});

test('Product Ads: ninguna escritura, nunca, ni en modo real', () => {
  const a = evaluarEscritura('ads', { modo: 'real' });
  assert.deepEqual(guardas(a), ['ads_solo_lectura']); assert.equal(a.alerta, true);
  const b = evaluarEscritura('sacar_de_promo', { modo: 'real', item: item(), promo: { type: 'DEAL', name: 'X' }, request: { method: 'POST', path: '/advertising/MLU/advertisers/1/product_ads/campaigns' } });
  assert.deepEqual(guardas(b), ['ads_solo_lectura']);
});

test('interruptor general y modo prueba: nada se ejecuta y no es una alerta', () => {
  const sl = evaluarEscritura('unirse_promo', base({ modo: 'solo_lectura' }));
  assert.deepEqual(guardas(sl), ['interruptor_solo_lectura']); assert.equal(sl.alerta, false);
  const pr = evaluarEscritura('unirse_promo', base({ modo: 'prueba' }));
  assert.deepEqual(guardas(pr), ['modo_prueba']); assert.equal(pr.alerta, false);
  assert.equal(evaluarEscritura('unirse_promo', base({ modo: undefined })).permitido, false, 'sin modo declarado es prueba');
  // En prueba igual se evalúa el resto: se ve qué frenaría.
  assert.deepEqual(guardas(evaluarEscritura('unirse_promo', base({ modo: 'prueba', item: item({ available_quantity: 1 }) }))), ['modo_prueba', 'stock_bajo']);
});

test('relámpago: irreversible, doble chequeo y 3 o más de stock después de reservar', () => {
  const l = (o = {}) => ({ lectura1: { precio: 1500, stock: 5 }, lectura2: { precio: 1500, stock: 5 }, reservar: 2, ...o });
  assert.deepEqual(evaluarLightning(l()), []);
  assert.deepEqual(evaluarLightning(l({ reservar: 3 })).map(f => f.guarda), ['lightning_stock_insuficiente']);
  assert.deepEqual(evaluarLightning(l({ lectura2: { precio: 1499, stock: 5 } })).map(f => f.guarda), ['lightning_lecturas_distintas']);
  assert.deepEqual(evaluarLightning(l({ lectura2: { precio: 1500, stock: 4 }, reservar: 1 })).map(f => f.guarda), ['lightning_lecturas_distintas']);
  // Con lecturas distintas se toma el stock menor: 4 menos 2 deja 2.
  assert.deepEqual(evaluarLightning(l({ lectura2: { precio: 1500, stock: 4 } })).map(f => f.guarda), ['lightning_lecturas_distintas', 'lightning_stock_insuficiente']);
  assert.deepEqual(evaluarLightning({ lectura1: { precio: 1, stock: 5 }, reservar: 1 }).map(f => f.guarda), ['lightning_sin_doble_chequeo']);
  assert.deepEqual(evaluarLightning(l({ lectura2: { precio: 1500 } })).map(f => f.guarda), ['lightning_lectura_incompleta']);
  assert.deepEqual(evaluarLightning(l({ reservar: 0 })).map(f => f.guarda), ['lightning_reserva_invalida']);
  // Integrada a la escritura: sin el doble chequeo no sale, aunque lo demás esté perfecto.
  assert.deepEqual(guardas(evaluarEscritura('lightning', base({ promo: { type: 'SMART_LIGHTNING', name: 'Relámpagos compartidas', price: 1150, seller_percentage: 11.5 } }))), ['lightning_sin_doble_chequeo']);
  assert.equal(evaluarEscritura('lightning', base({ promo: { type: 'SMART_LIGHTNING', name: 'Relámpagos compartidas', price: 1150, seller_percentage: 11.5 }, lightning: l() })).permitido, true);
});

test('después de escribir: se relee sale_price y si el visible pasa de 16 % se saca el ítem', () => {
  assert.deepEqual(verificarPostEscritura({ amount: 2056.4, regular_amount: 2650 }).accion, 'sacar');
  const ok = verificarPostEscritura({ amount: 1150, regular_amount: 1300 });
  assert.deepEqual([ok.ok, ok.accion, ok.visiblePct], [true, 'ninguna', 11.54]);
  assert.equal(verificarPostEscritura({ amount: 840, regular_amount: 1000 }).ok, true, '16 % exacto pasa');
  assert.equal(verificarPostEscritura({ amount: 1300, regular_amount: null }).ok, true);
  const noLeido = verificarPostEscritura(null);
  assert.deepEqual([noLeido.ok, noLeido.accion], [false, 'sacar']);
});

test('fila de alerta: clave estable por guarda, ítem y día; "[PRUEBA]" fuera del modo real', () => {
  const r = evaluarEscritura('unirse_promo', base({ promo: { type: 'DEAL', name: 'X', price: 1098, seller_percentage: 15.54 } }));
  const prueba = filaAlerta({ fecha: '2026-11-11', modo: 'prueba', accion: 'unirse_promo', item: item(), promo: { name: 'X' }, resultado: r });
  assert.equal(prueba.Clave, 'promos|alerta|descuento_alto|MLU100|2026-11-11');
  assert.match(prueba.Propuesta, /^\[PRUEBA\] /);
  assert.deepEqual([prueba.Tipo, prueba.Estado, prueba.Rama, prueba.Prioridad], ['Alerta', 'Nueva', 'Promos y cupones', 'Alta']);
  assert.match(prueba.Dato, /descuento_alto: Descuento a cargo nuestro 15\.54%/);
  assert.equal(filaAlerta({ fecha: '2026-11-11', modo: 'real', accion: 'unirse_promo', item: item(), resultado: r }).Propuesta.startsWith('[PRUEBA]'), false);
  assert.equal(filaAlerta({ fecha: '2026-11-11', accion: 'unirse_promo', item: item(), resultado: r }).Clave, prueba.Clave, 'correr dos veces no duplica');
});

test('descuentoPct y los límites quedan como los fijó Seba', () => {
  assert.equal(descuentoPct(2650, 2056.4), 22.4);
  assert.equal(descuentoPct(0, 10), null);
  assert.equal(descuentoPct('x', 10), null);
  // Tope de Ads: $20.000 por mes calendario (Seba, 11/11/2026; antes 30.000).
  assert.deepEqual({ ...LIMITES }, { descuentoMaxPct: 15, visibleMaxPct: 16, promoMasCuponMaxUyu: 750, cuponPorDefectoUyu: 500, stockMinimoParaPromo: 3, diasMinimosDesdeAlta: 90, stockMinimoTrasReservar: 3, adsMensualMaxUyu: 20000, adsAlertaPct: 80 });
  assert.throws(() => { 'use strict'; LIMITES.descuentoMaxPct = 99; });
});
