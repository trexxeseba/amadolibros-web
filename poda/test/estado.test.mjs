import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calcularDia, diasEntre } from '../src/estado.mjs';

const hoy = '2026-11-13';
const grupo = (id, o = {}) => ({ id, external_id: `MLU${id}`, tipo: 'ITEM', item_ids: [`MLU${id}`], titulo: `Libro ${id}`, campaign_id: 1, estado: 'ACTIVE',
  precio: 2500, precioTope: 2500, promo: false, gasto: 0, clics: 0, cpc: null, ventasAtribuidas: 0, ventasOrdenes: 0, ...o });
const mapa = (...gs) => new Map(gs.map(g => [String(g.id), g]));

test('un activo sin venta que llegó al tope se propone para pausar', () => {
  const r = calcularDia({ hoy, grupos: mapa(grupo(1, { gasto: 260, clics: 12, cpc: 21 })) });
  assert.equal(r.listas.pausar.length, 1);
  assert.equal(r.cambios[0].fila.estado, 'propuesta_pausa');
  assert.equal(r.contadores.pausar, 1);
});

test('en auditar no propone pausas, sólo cuenta las que haría', () => {
  const r = calcularDia({ hoy, accion: 'auditar', grupos: mapa(grupo(1, { gasto: 260, clics: 12, cpc: 21 })) });
  assert.equal(r.listas.pausar.length, 0);
  assert.equal(r.listas.pausaria.length, 1);
  assert.equal(r.cambios.length, 0);
});

test('una propuesta que el Agente único ya pausó pasa a pausado', () => {
  const registro = [{ ad_group_id: '1', external_id: 'MLU1', estado: 'propuesta_pausa', origen: 'poda', fecha_propuesta: '2026-11-12' }];
  const r = calcularDia({ hoy, grupos: mapa(grupo(1, { estado: 'PAUSED', gasto: 260, clics: 12 })), registro });
  assert.equal(r.cambios[0].fila.estado, 'pausado');
  assert.equal(r.cambios[0].fila.fecha_pausa, hoy);
});

test('una propuesta pendiente que ya no corresponde (entró una venta) se borra', () => {
  const registro = [{ ad_group_id: '1', external_id: 'MLU1', estado: 'propuesta_pausa', origen: 'poda', fecha_propuesta: '2026-11-12' }];
  const r = calcularDia({ hoy, grupos: mapa(grupo(1, { gasto: 260, clics: 12, cpc: 21, ventasOrdenes: 1 })), registro });
  assert.equal(r.cambios.some(c => c.tipo === 'borrar'), true);
  assert.equal(r.listas.pendientesPausa.length, 0);
});

test('una propuesta que sigue vigente y no se ejecutó queda en pendientes, sin duplicarse', () => {
  const registro = [{ ad_group_id: '1', external_id: 'MLU1', estado: 'propuesta_pausa', origen: 'poda', fecha_propuesta: '2026-11-12' }];
  const r = calcularDia({ hoy, grupos: mapa(grupo(1, { gasto: 270, clics: 13, cpc: 21 })), registro });
  assert.equal(r.listas.pendientesPausa.length, 1);
  assert.equal(r.listas.pausar.length, 0, 'no se propone dos veces');
});

test('regla 5: un pausado por la poda con venta tardía pasa a reactivar', () => {
  const registro = [{ ad_group_id: '1', external_id: 'MLU1', estado: 'pausado', origen: 'poda', precio_lista: 2500, promo: 0, fecha_pausa: '2026-11-12' }];
  const r = calcularDia({ hoy, accion: 'auditar', grupos: mapa(grupo(1, { estado: 'PAUSED', ventasAtribuidas: 1 })), registro });
  assert.equal(r.listas.reactivar.length, 1);
  assert.equal(r.listas.reactivar[0].regla, 5);
});

test('regla 6: cambió el precio de un pausado, se propone reactivar y al reactivarse queda contando de cero', () => {
  const registro = [{ ad_group_id: '1', external_id: 'MLU1', estado: 'pausado', origen: 'poda', precio_lista: 2500, promo: 0, fecha_pausa: '2026-11-12' }];
  const r1 = calcularDia({ hoy, grupos: mapa(grupo(1, { estado: 'PAUSED', precioTope: 2000 })), registro });
  assert.equal(r1.listas.reactivar[0].regla, 6);
  const fila = r1.cambios.find(c => c.tipo === 'upsert').fila;
  assert.equal(fila.estado, 'propuesta_reactivar');
  const r2 = calcularDia({ hoy: '2026-11-14', grupos: mapa(grupo(1, { estado: 'ACTIVE', precioTope: 2000 })), registro: [fila] });
  const nueva = r2.cambios.find(c => c.tipo === 'upsert').fila;
  assert.equal(nueva.estado, 'contando');
  assert.equal(nueva.contar_desde, hoy);
});

test('un pausado que no está en el registro lo pausó otra persona: no se toca', () => {
  const r = calcularDia({ hoy, grupos: mapa(grupo(1, { estado: 'PAUSED', ventasAtribuidas: 3 })) });
  assert.equal(r.listas.reactivar.length, 0);
  assert.equal(r.cambios.length, 0);
});

test('semilla: lo pausado a mano por el Agente único entra al registro y no se reactiva sin regla 5 o 6', () => {
  const g = grupo(7, { estado: 'PAUSED' });
  const r = calcularDia({ hoy, grupos: mapa(g), semillas: [{ external_id: 'MLU7', origen: 'agente_manual', fecha_pausa: '2026-11-12' }] });
  const fila = r.cambios.find(c => c.tipo === 'upsert').fila;
  assert.equal(fila.estado, 'pausado');
  assert.equal(fila.origen, 'agente_manual');
  assert.equal(r.listas.reactivar.length, 0);
});

test('un anuncio sin venta y con la mitad del tope va a observación; clic caro se informa', () => {
  const r = calcularDia({ hoy, grupos: mapa(grupo(1, { gasto: 130, clics: 8, cpc: 16 }), grupo(2, { gasto: 40, clics: 2, cpc: 101 })) });
  assert.equal(r.listas.observar.length, 1);
  assert.equal(r.listas.clicCaro.length, 1);
});

test('el freno deja afuera los excedentes y avisa', () => {
  const gs = Array.from({ length: 30 }, (_, i) => grupo(i + 1, { gasto: 300 + i, clics: 20, cpc: 15 }));
  const r = calcularDia({ hoy, grupos: mapa(...gs) });
  assert.equal(r.listas.pausar.length, 25);
  assert.equal(r.listas.excedentes.length, 5);
  assert.equal(r.alertaFreno, true);
});

test('contando: pasados 30 días se borra del registro', () => {
  const registro = [{ ad_group_id: '1', external_id: 'MLU1', estado: 'contando', origen: 'poda', contar_desde: '2026-10-01' }];
  const r = calcularDia({ hoy, grupos: mapa(grupo(1)), registro });
  assert.equal(r.cambios.some(c => c.tipo === 'borrar'), true);
});

test('diasEntre', () => assert.equal(diasEntre('2026-11-01', '2026-11-13'), 12));

test('lista de transparencia: con gasto de 150 o más que no se pausan, con el motivo', () => {
  const r = calcularDia({ hoy, grupos: mapa(grupo(1, { gasto: 300, clics: 3, cpc: 100 }), grupo(2, { gasto: 400, clics: 20, cpc: 20, ventasAtribuidas: 1 }), grupo(3, { gasto: 260, clics: 12, cpc: 21 }), grupo(4, { estado: 'PAUSED', gasto: 200 })) });
  const m = Object.fromEntries(r.listas.conGasto.map(f => [f.ad_group_id, f.motivo]));
  assert.match(m['1'], /Menos de 5 clics/); assert.match(m['2'], /Venta atribuida/); assert.match(m['4'], /PAUSED/);
  assert.equal(m['3'], undefined, 'el que se pausa no está en esta lista');
});
