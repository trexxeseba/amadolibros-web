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

const A = o => ({ estado: 'ACTIVE', gasto: 0, clics: 0, ventasAtribuidas: 0, ventasOrdenes: 0, precio: 2500, ...o });

test('regla A (26/11): 15 o más clics sin venta en 30 días se pausa; 14 no', () => {
  assert.equal(evaluarAnuncio(A({ gasto: 200, clics: 15 })).accion, 'pausar');
  assert.equal(evaluarAnuncio(A({ gasto: 200, clics: 15 })).regla, 'A');
  assert.equal(evaluarAnuncio(A({ gasto: 200, clics: 14 })).accion, 'observar');
});

test('regla A no pausa si hubo venta (atribuida o en órdenes) y el ROAS da', () => {
  assert.equal(evaluarAnuncio(A({ gasto: 200, clics: 30, ventasAtribuidas: 1, monto: 2500 })).accion, 'mantener');
});

test('regla B (26/11): 3 días seguidos con gasto y sin ventas se pausa', () => {
  const dias3 = [{ gasto: 20, ventas: 0 }, { gasto: 15, ventas: 0 }, { gasto: 5, ventas: 0 }];
  assert.equal(evaluarAnuncio(A({ gasto: 40, clics: 4, dias3 })).regla, 'B');
  assert.equal(evaluarAnuncio(A({ gasto: 40, clics: 4, dias3: [{ gasto: 20, ventas: 0 }, { gasto: 0, ventas: 0 }, { gasto: 5, ventas: 0 }] })).accion, 'mantener');
  assert.equal(evaluarAnuncio(A({ gasto: 40, clics: 4, dias3: [{ gasto: 20, ventas: 1 }, { gasto: 15, ventas: 0 }, { gasto: 5, ventas: 0 }] })).accion, 'mantener');
});

test('regla C (26/11): ROAS sostenido abajo de 2,5 (30 y 7 días) se pausa; si en 7 días repuntó, no', () => {
  assert.equal(evaluarAnuncio(A({ gasto: 1000, clics: 40, ventasAtribuidas: 1, monto: 2000, gasto7: 300, monto7: 0 })).regla, 'C');
  assert.equal(evaluarAnuncio(A({ gasto: 1000, clics: 40, ventasAtribuidas: 1, monto: 2000, gasto7: 300, monto7: 2000 })).accion, 'mantener');
  assert.equal(evaluarAnuncio(A({ gasto: 1000, clics: 40, ventasAtribuidas: 1, monto: 3000 })).accion, 'mantener');
});

test('pausa provisoria: con clics en los últimos 7 días queda marcada', () => {
  const r = evaluarAnuncio(A({ gasto: 200, clics: 20, clics7: 3 }));
  assert.equal(r.accion, 'pausar'); assert.equal(r.provisoria, true); assert.match(r.motivo, /PROVISORIA/);
  assert.equal(evaluarAnuncio(A({ gasto: 200, clics: 20, clics7: 0 })).provisoria, false);
});

test('regla 8: pausados no aplican; protegidas no se tocan', () => {
  assert.equal(evaluarAnuncio(A({ estado: 'PAUSED', clics: 50 })).accion, 'no_aplica');
  assert.equal(evaluarAnuncio(A({ clics: 50, protegido: 'Campaña protegida.' })).accion, 'protegido');
});

test('regla 5: una venta atribuida tarde o una venta en órdenes reactiva', () => {
  assert.equal(evaluarReactivacion({ precio_lista: 2500 }, { ventasAtribuidas: 1, precioLista: 2500 }).accion, 'reactivar');
  assert.equal(evaluarReactivacion({ precio_lista: 2500 }, { ventasOrdenesDesdePausa: 1, precioLista: 2500 }).regla, 5);
  assert.equal(evaluarReactivacion({ precio_lista: 2500 }, { ventasAtribuidas: 0, ventasOrdenesDesdePausa: 0, precioLista: 2500 }).accion, 'mantener');
});

test('regla 5 con venta cara: sus ventas atribuidas de antes no lo reactivan; una orden nueva sí', () => {
  const reg = { precio_lista: 2500, motivo: 'Venta cara: gastó 900 para 1 venta...' };
  assert.equal(evaluarReactivacion(reg, { ventasAtribuidas: 1, ventasOrdenesDesdePausa: 0, precioLista: 2500 }).accion, 'mantener');
  assert.equal(evaluarReactivacion(reg, { ventasAtribuidas: 1, ventasOrdenesDesdePausa: 1, precioLista: 2500 }).regla, 5);
});

test('regla 6: una suba de precio NO reactiva (ajuste del 14/11)', () => {
  assert.equal(evaluarReactivacion({ precio_lista: 3321 }, { precioLista: 3700 }).accion, 'mantener');
  assert.equal(evaluarReactivacion({ precio_lista: 2868 }, { precioLista: 3200 }).accion, 'mantener');
});

test('regla 6: baja de precio o promoción nueva reactivan y el gasto se cuenta de cero', () => {
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
