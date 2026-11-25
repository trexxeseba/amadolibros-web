import { test } from 'node:test';
import assert from 'node:assert/strict';
import { armarInforme, markdown, unidades } from '../src/ventas.mjs';
import { CUENTAS } from '../src/config.mjs';

const DIA = 86400_000, AHORA = Date.parse('2026-11-12T12:00:00Z');
const estado = { publicaciones: {
  MLU1: { titulo: 'Libro uno', precio_original: 1000, precio_aplicado: 900, fecha_primera_baja: new Date(AHORA - 10 * DIA).toISOString() },
  MLU2: { titulo: 'Libro dos', precio_original: 2000, precio_aplicado: 1800, fecha_primera_baja: new Date(AHORA - 5 * DIA).toISOString() },
  MLU3: { titulo: 'Reciente', precio_original: 500, precio_aplicado: 450, fecha_primera_baja: new Date(AHORA - 3600e3).toISOString() },
} };
// MLU1: 14 antes, 20 después en 10 días. MLU2: 7 antes, 5 después en 5 días.
const ventas = (id, a, b) => ({ MLU1: [14, 20], MLU2: [7, 5] }[id]?.[b <= Date.parse(estado.publicaciones[id].fecha_primera_baja) ? 0 : 1] ?? 0);

test('compara antes y después, y el efecto es el cambio de las bajadas menos el del control', () => {
  const r = armarInforme({ estado, ventas, ahoraMs: AHORA, control: { antes: 10, despues: 11 } });
  assert.equal(r.tot.publicaciones, 2);
  assert.equal(r.tot.unidades_antes, 21); assert.equal(r.tot.unidades_despues, 25);
  // por día: antes 1 + 0,5 = 1,5; después 2 + 1 = 3 → +100 %. Control +10 %. Efecto +90 puntos.
  assert.ok(Math.abs(r.cambioGestionadas - 1) < 1e-9);
  assert.ok(Math.abs(r.efecto - 0.9) < 1e-9);
  // Margen cedido: (1000-900)×20 + (2000-1800)×5 = 3000
  assert.equal(r.tot.margen_cedido, 3000);
  assert.equal(r.filas.find(f => f.id === 'MLU3').muestra, 'muy_reciente');
});
test('el markdown no inventa: sin control dice sin datos', () => {
  const r = armarInforme({ estado, ventas, ahoraMs: AHORA, control: null });
  assert.equal(r.efecto, null);
  assert.match(markdown({ ...r, control: null }, { cuenta: CUENTAS.libros, fecha: '2026-11-12' }), /sin datos/);
});
test('unidades suma por publicación sin las canceladas (consulta inyectada)', async () => {
  let sqlVisto = '';
  const m = await unidades(1, 2, async (sql, p) => { sqlVisto = sql; return [{ item_id: 'MLU1', u: 3 }, { item_id: 'MLU2', u: '2' }]; });
  assert.deepEqual([...m], [['MLU1', 3], ['MLU2', 2]]);
  assert.match(sqlVisto, /NOT IN \('cancelled','invalid'\)/);
  assert.match(sqlVisto, /^\s*SELECT/);
});
