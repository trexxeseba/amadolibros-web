import { test } from 'node:test';
import assert from 'node:assert/strict';
import { candidatos, markdown } from '../src/baratos.mjs';
import { CUENTAS } from '../src/config.mjs';

const f = (id, precio, mas_barato, gana = true) => ({ id, titulo: 'Libro ' + id, precio, mas_barato, gana });

test('Contabilidad de Costos: 3300 con el competidor a 6230 → sugiere 4290 (30 % tope) en 2 pasos', () => {
  const [c] = candidatos([f('MLU890137504', 3300, 6230)]);
  assert.deepEqual([c.sugerido, c.ganancia_por_unidad, c.en_un_paso], [4290, 990, false]);
});
test('El Futuro del Homo: 1600 contra 1886 → 1.18 veces, no llega a 1.25: no entra', () => {
  assert.deepEqual(candidatos([f('MLU659606906', 1600, 1886)]), []);
});
test('si el 97 % del competidor está dentro del 30 %, sube en un paso', () => {
  const [c] = candidatos([f('MLU1', 1000, 1300)]);
  assert.deepEqual([c.sugerido, c.en_un_paso], [1261, true]);
});
test('sólo los que ganamos la ficha; ordenados por ganancia', () => {
  const l = candidatos([f('A', 1000, 1400, false), f('B', 1000, 1300), f('C', 3000, 6000)]);
  assert.deepEqual(l.map(x => x.id), ['C', 'B']);
});
test('el markdown dice que no se cambió nada y linkea la publicación', () => {
  const md = markdown(candidatos([f('MLU890137504', 3300, 6230)]), { cuenta: CUENTAS.libros, fecha: '2026-11-12', total: 3075 });
  assert.match(md, /nada se cambió/);
  assert.match(md, /articulo\.mercadolibre\.com\.uy\/MLU-890137504/);
  assert.match(md, /4290 \(en 2 pasos\)/);
});
