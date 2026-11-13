import { test } from 'node:test';
import assert from 'node:assert/strict';
import { topeGasto, topeClics, costoPorClic, precioParaTope, evaluarAnuncio, evaluarReactivacion, aplicarFreno, REGLAS } from '../src/reglas.mjs';

test('regla 1: tope de gasto = 10 % del precio, piso 150 y techo 400', () => {
  assert.equal(topeGasto(1500), 150);
  assert.equal(topeGasto(900), 150, 'por debajo del piso sube a 150');
  assert.equal(topeGasto(2500), 250);
  assert.equal(topeGasto(3500), 350);
  assert.equal(topeGasto(4500), 400);
  assert.equal(topeGasto(9000), 400, 'techo');
  assert.equal(topeGasto(null), null);
  assert.equal(topeGasto(0), null);
});

test('regla 2: clics que se aguantan = tope / costo por clic, mínimo 5 (libro de $2.500)', () => {
  const tope = topeGasto(2500);
  assert.equal(topeClics(tope, 10), 25);
  assert.equal(topeClics(tope, 20), 12);
  assert.equal(topeClics(tope, 40), 6);
  assert.equal(topeClics(tope, 60), 5);
  assert.equal(topeClics(tope, 200), 5, 'nunca menos de 5');
  assert.equal(topeClics(tope, null), null);
});

test('costo por clic: el informado o gasto / clics', () => {
  assert.equal(costoPorClic({ cpc: 12.5, gasto: 100, clics: 4 }), 12.5);
  assert.equal(costoPorClic({ cpc: 0, gasto: 100, clics: 4 }), 25);
  assert.equal(costoPorClic({ cpc: null, gasto: 0, clics: 0 }), null);
});

test('regla 9: con promoción se usa el precio de lista', () => {
  assert.equal(precioParaTope({ precio: 2000, precioLista: 2500 }), 2500);
  assert.equal(precioParaTope({ precio: 2500, precioLista: null }), 2500);
  assert.equal(precioParaTope({ precio: 2500, precioLista: 2000 }), 2500);
  assert.equal(precioParaTope({ precio: null, precioLista: null }), null);
});

const base = { estado: 'ACTIVE', precio: 2500, gasto: 0, clics: 0, cpc: null, ventasAtribuidas: 0, ventasOrdenes: 0 };

test('regla 3: se pausa al llegar al tope de gasto sin ninguna venta', () => {
  const r = evaluarAnuncio({ ...base, gasto: 250, clics: 12, cpc: 20.8 });
  assert.equal(r.accion, 'pausar');
  assert.equal(r.tope, 250);
});

test('regla 3: se pausa al llegar al tope de clics aunque el gasto no llegue', () => {
  // clic $10: tope de 25 clics, gasto 240 < 250
  const r = evaluarAnuncio({ ...base, gasto: 240, clics: 25, cpc: 9.6 });
  assert.equal(r.topeClics, 26, 'con cpc 9,6 el tope de clics es 26');
  const r2 = evaluarAnuncio({ ...base, gasto: 245, clics: 25, cpc: 10 });
  assert.equal(r2.topeClics, 25);
  assert.equal(r2.accion, 'pausar');
});

test('nunca se pausa con menos de 5 clics, aunque el gasto pase el tope', () => {
  const r = evaluarAnuncio({ ...base, gasto: 400, clics: 4, cpc: 100 });
  assert.equal(r.accion, 'mantener');
  assert.match(r.motivo, /5 clics/);
  assert.equal(evaluarAnuncio({ ...base, gasto: 400, clics: 5, cpc: 80 }).accion, 'pausar');
});

test('regla 4: con una venta atribuida no se pausa aunque llegue al tope', () => {
  const r = evaluarAnuncio({ ...base, gasto: 900, clics: 60, cpc: 15, ventasAtribuidas: 1 });
  assert.equal(r.accion, 'mantener');
});

test('regla 4: una venta no atribuida (en órdenes) también frena la pausa', () => {
  const r = evaluarAnuncio({ ...base, gasto: 900, clics: 60, cpc: 15, ventasOrdenes: 1 });
  assert.equal(r.accion, 'mantener');
});

test('debajo del tope se mantiene; desde la mitad queda en observación', () => {
  assert.equal(evaluarAnuncio({ ...base, gasto: 50, clics: 6, cpc: 8 }).accion, 'mantener');
  assert.equal(evaluarAnuncio({ ...base, gasto: 130, clics: 8, cpc: 16 }).accion, 'observar');
});

test('regla 8: sin precio no se pausa; pausados y deshabilitados no aplican; protegidas no se tocan', () => {
  assert.equal(evaluarAnuncio({ ...base, precio: null, gasto: 500, clics: 30, cpc: 16 }).accion, 'falta_precio');
  assert.equal(evaluarAnuncio({ ...base, estado: 'PAUSED', gasto: 500, clics: 30 }).accion, 'no_aplica');
  assert.equal(evaluarAnuncio({ ...base, estado: 'HOLD', gasto: 500, clics: 30 }).accion, 'no_aplica');
  assert.equal(evaluarAnuncio({ ...base, gasto: 500, clics: 30, cpc: 16, protegido: 'Campaña protegida' }).accion, 'protegido');
});

test('regla 9: con promoción el tope sale del precio de lista', () => {
  // precio visible 1.400 (tope 150) pero de lista 2.500 (tope 250): gastó 200, no se pausa
  const r = evaluarAnuncio({ ...base, precio: 1400, precioLista: 2500, gasto: 200, clics: 9, cpc: 22 });
  assert.equal(r.tope, 250);
  assert.notEqual(r.accion, 'pausar');
});

test('regla 7: clic caro = costo por clic mayor al 4 % del precio, sólo se informa', () => {
  const r = evaluarAnuncio({ ...base, gasto: 120, clics: 4, cpc: 101 });
  assert.equal(r.clicCaro, true);
  assert.notEqual(r.accion, 'pausar', 'informar no pausa por sí solo');
  assert.equal(evaluarAnuncio({ ...base, gasto: 20, clics: 2, cpc: 101 }).clicCaro, true);
  assert.equal(evaluarAnuncio({ ...base, gasto: 50, clics: 5, cpc: 100 }).clicCaro, false, 'justo el 4 % no es caro');
});

test('regla 5: una venta atribuida tarde o una venta en órdenes reactiva', () => {
  assert.equal(evaluarReactivacion({ precio_lista: 2500 }, { ventasAtribuidas: 1, precioLista: 2500 }).accion, 'reactivar');
  assert.equal(evaluarReactivacion({ precio_lista: 2500 }, { ventasOrdenesDesdePausa: 1, precioLista: 2500 }).regla, 5);
  assert.equal(evaluarReactivacion({ precio_lista: 2500 }, { ventasAtribuidas: 0, ventasOrdenesDesdePausa: 0, precioLista: 2500 }).accion, 'mantener');
});

test('regla 6: cambio de precio o promoción nueva reactivan y el gasto se cuenta de cero', () => {
  const a = evaluarReactivacion({ precio_lista: 2500 }, { precioLista: 2000 });
  assert.equal(a.accion, 'reactivar'); assert.equal(a.regla, 6);
  const b = evaluarReactivacion({ precio_lista: 2500, promo: 0 }, { precioLista: 2500, promo: true });
  assert.equal(b.regla, 6);
  assert.equal(evaluarReactivacion({ precio_lista: 2500, promo: 1 }, { precioLista: 2500, promo: true }).accion, 'mantener');
});

test('frenos: máximo 25 por corrida y 60 por día; los excedentes no se proponen y alertan', () => {
  const cand = Array.from({ length: 30 }, (_, i) => ({ ad_group_id: String(i), gasto: 100 + i }));
  const f = aplicarFreno(cand);
  assert.equal(f.entran.length, REGLAS.maxPorCorrida);
  assert.equal(f.excedentes.length, 5);
  assert.equal(f.alerta, true);
  assert.equal(f.entran[0].gasto, 129, 'entran primero los de más gasto');
  const g = aplicarFreno(cand, { nuevasHoy: 50 });
  assert.equal(g.entran.length, 10, 'quedan 10 lugares en el día');
  assert.equal(aplicarFreno(cand.slice(0, 3)).alerta, false);
  assert.equal(aplicarFreno(cand, { nuevasHoy: 60 }).entran.length, 0);
});
