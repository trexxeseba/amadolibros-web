// Subida con memoria (07/11/2026). Caso real: Mi Viaje Sin Ti, original 764. Gana en
// 628 con el competidor en 655; antes subía directo a 654 y en la corrida siguiente
// volvía a perder y bajaba a 628, todo el día.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decidir } from '../src/decision.mjs';

const AHORA = Date.parse('2026-11-07T15:00:00Z');
const item = (price, o = {}) => ({ id: 'MLU692647026', price, currency_id: 'UYU', variaciones: false, demanda: false, available_quantity: 1, ...o });
const gana = (techo = 654) => ({ marcada: false, compite: false, estado: 'winning', techo, techo_de: techo + 1 });
const pierde = ganador => ({ marcada: true, ganador, estado: 'competing' });
const L = { pasoMinimoSubida: 10, ahora: AHORA };
const base = { precio_original: 764, precio_aplicado: 628 };

test('primera corrida ganando: no sube, cuenta 1 de 2', () => {
  const d = decidir({ item: item(628), comp: gana(), previo: base, ...L });
  assert.equal(d.accion, 'mantener'); assert.deepEqual(d.memoria, { ganando: 1 });
});
test('segunda corrida ganando: sube la mitad de lo que falta y vuelve a contar desde cero', () => {
  const d = decidir({ item: item(628), comp: gana(), previo: { ...base, ganando: 1 }, ...L });
  assert.deepEqual([d.accion, d.precio], ['subir', 641]);   // 628 + (654 - 628) / 2
  assert.deepEqual(d.memoria, { ganando: 0 });
});
test('si después de subir pierde, baja al ganador y recuerda dónde perdió', () => {
  const d = decidir({ item: item(641), comp: pierde(628), previo: { ...base, precio_aplicado: 641 }, ...L });
  assert.deepEqual([d.accion, d.precio], ['ajustar', 628]);
  assert.equal(d.memoria.perdio_en, 641); assert.equal(d.memoria.ganando, 0);
});
test('con la memoria vigente no vuelve a subir hasta donde perdió', () => {
  const previo = { ...base, ganando: 1, perdio_en: 641, perdio_fecha: new Date(AHORA - 3600e3).toISOString() };
  const d = decidir({ item: item(628), comp: gana(), previo, ...L });
  // Techo 641 - 10 = 631: subiría 3, menos del paso mínimo de 10.
  assert.equal(d.accion, 'mantener');
  assert.match(d.motivo, /perdió en 641|menos de 10/);
});
test('la memoria vence a los 3 días', () => {
  const previo = { ...base, ganando: 1, perdio_en: 641, perdio_fecha: new Date(AHORA - 4 * 86400e3).toISOString() };
  assert.deepEqual([decidir({ item: item(628), comp: gana(), previo, ...L }).precio], [641]);
});
test('lo que falta es poco (hasta 2 pasos): sube todo de una', () => {
  const d = decidir({ item: item(640), comp: gana(654), previo: { ...base, precio_aplicado: 640, ganando: 1 }, ...L });
  assert.deepEqual([d.accion, d.precio], ['subir', 654]);
});
test('sin competidor: igual espera la confirmación y después se acerca al original', () => {
  const sin = { marcada: false, estado: 'winning', techo: null };
  assert.equal(decidir({ item: item(628), comp: sin, previo: base, ...L }).accion, 'mantener');
  const d = decidir({ item: item(628), comp: sin, previo: { ...base, ganando: 1 }, ...L });
  assert.deepEqual([d.accion, d.precio], ['subir', 696]);   // 628 + (764 - 628) / 2
  const fin = decidir({ item: item(750), comp: sin, previo: { ...base, precio_aplicado: 750, ganando: 1 }, ...L });
  assert.deepEqual([fin.accion, fin.precio], ['restaurar', 764]);
});
test('bajar sigue siendo inmediato: perder no espera confirmación', () => {
  const d = decidir({ item: item(654), comp: pierde(628), previo: { ...base, precio_aplicado: 654, ganando: 5 }, ...L });
  assert.deepEqual([d.accion, d.precio], ['ajustar', 628]);
});
test('simulación de un día: converge sin ir y venir', () => {
  // ML marca perdedora cualquier precio de 635 o más (pesa envío y reputación).
  const LIMITE = 635;
  let precio = 628, previo = { ...base }, movimientos = 0;
  for (let corrida = 0; corrida < 7; corrida++) {
    const comp = precio >= LIMITE ? pierde(628) : gana(654);
    const d = decidir({ item: item(precio), comp, previo: { ...previo, precio_aplicado: precio }, ...L, ahora: AHORA + corrida * 7200e3 });
    Object.assign(previo, d.memoria);
    if (d.precio && d.precio !== precio) { precio = d.precio; movimientos++; }
  }
  // Antes: 628 → 654 → 628 → 654 … (6 movimientos). Ahora: sube una vez, pierde, baja y se queda.
  assert.ok(movimientos <= 2, `movimientos ${movimientos}`);
  assert.equal(precio, 628);
});
