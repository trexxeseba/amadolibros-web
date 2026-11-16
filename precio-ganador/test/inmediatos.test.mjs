import { test } from 'node:test';
import assert from 'node:assert/strict';
import { masBaratas, resumir, estadisticas, markdown } from '../src/inmediatos.mjs';
import { CUENTAS } from '../src/config.mjs';

const item = { id: 'MLU1', titulo: 'Libro uno', price: 1000, pid: 'MLUP1' };
const of = (item_id, seller_id, price, extra = {}) => ({ item_id, seller_id, price, ...extra });
const entregas = mapa => async o => mapa[o.item_id] ?? 'sin_dato';

test('masBaratas: deja afuera lo propio, lo de la casa, lo usado, lo más caro y lo mal formado', () => {
  const ofertas = [of('MLU2', '111', 900), of('MLU3', '440298103', 800), of('MLU4', '2341378249', 700), of('MLU5', '222', 600, { condition: 'used' }),
    of('MLU6', '333', 1200), of('MLU1', '444', 500), of('MLU7', '555', 950), of('MLU8', '666', null), null];
  const r = masBaratas(item, ofertas, { sellerId: '440298103', casa: new Set(['2341378249']) });
  assert.deepEqual(r.map(o => o.item_id), ['MLU2', 'MLU7']);
});

test('resumir: el inmediato más barato manda y la brecha se calcula sobre nuestro precio', async () => {
  const baratas = [of('MLU2', '111', 800), of('MLU3', '222', 900)];
  const r = await resumir(item, baratas, entregas({ MLU2: 'inmediato', MLU3: 'inmediato' }));
  assert.deepEqual([r.mas_barato_inmediato.item_id, r.brecha_pct, r.baratas_a_demanda], ['MLU2', 20, 0]);
});

test('resumir: los más baratos a demanda no cuentan, pero se anotan; sigue hasta el primer inmediato', async () => {
  const baratas = [of('MLU2', '111', 700), of('MLU3', '222', 800), of('MLU4', '333', 900)];
  const r = await resumir(item, baratas, entregas({ MLU2: 'demanda', MLU3: 'sin_dato', MLU4: 'inmediato' }));
  assert.deepEqual([r.mas_barato_inmediato.item_id, r.baratas_a_demanda, r.baratas_sin_dato, r.verificadas], ['MLU4', 1, 1, 3]);
});

test('resumir: un vendedor de SLOW_SELLERS cuenta a demanda sin consultar su entrega', async () => {
  let consultas = 0;
  const lentos = new Map([['999', 'lento']]);
  const r = await resumir(item, [of('MLU2', '999', 700)], async () => { consultas++; return 'inmediato'; }, { lentos });
  assert.deepEqual([r.mas_barato_inmediato, r.baratas_a_demanda, consultas], [null, 1, 0]);
});

test('resumir: no mira más de `max` ofertas por publicación', async () => {
  const baratas = Array.from({ length: 10 }, (_, i) => of('MLU' + (20 + i), '5' + i, 100 + i));
  const r = await resumir(item, baratas, entregas({}), { max: 4 });
  assert.deepEqual([r.verificadas, r.baratas_sin_dato], [4, 4]);
});

test('estadisticas: porcentaje, mediana y las de 20 % o más', () => {
  const f = (brecha, aDemanda = 0) => ({ mas_barato_inmediato: brecha === null ? null : { price: 1 }, brecha_pct: brecha, baratas_a_demanda: aDemanda });
  const s = estadisticas([f(10), f(30), f(50), f(null, 2), f(null)]);
  assert.deepEqual([s.medidas, s.mas_caras_que_inmediato, s.pct, s.brecha_mediana_pct, s.brecha_20_o_mas, s.solo_baratas_a_demanda], [5, 3, 60, 30, 2, 1]);
});

test('estadisticas: sin filas no inventa porcentajes', () => {
  assert.deepEqual([estadisticas([]).pct, estadisticas([]).brecha_mediana_pct], [null, null]);
});

test('markdown: ordena por diferencia y linkea la publicación', () => {
  const f = (id, precio, price, brecha) => ({ id, titulo: 'Libro ' + id, precio, mas_barato_inmediato: { price, seller_id: '9' }, brecha_pct: brecha });
  const md = markdown('Prueba', [f('MLU1', 1000, 900, 10), f('MLU2', 1000, 500, 50)], { cuenta: CUENTAS.libros, fecha: '2026-11-15' });
  assert.ok(md.indexOf('MLU-2') < md.indexOf('MLU-1'));
  assert.match(md, /2 de 2 publicaciones medidas/);
});
