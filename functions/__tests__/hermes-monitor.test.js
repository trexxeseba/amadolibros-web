import test from 'node:test';
import assert from 'node:assert/strict';
import {ofertaDeHermes, estadoFicha, cambioDePrecio, fallaGeneral, ultimosPorFicha, armarResumen} from '../../hermes-monitor/lib.mjs';
import {correr} from '../../hermes-monitor/chequeo.mjs';

test('ofertaDeHermes encuentra al vendedor de Hermes o devuelve null', () => {
  assert.equal(ofertaDeHermes([{seller_id: 1}, {seller_id: 471589392, price: 10}]).price, 10);
  assert.equal(ofertaDeHermes([{seller_id: 1}]), null);
  assert.equal(ofertaDeHermes(undefined), null);
});

test('estadoFicha: un error nunca cuenta como sin oferta', () => {
  assert.equal(estadoFicha({error: 'http_500'}), 'error');
  assert.equal(estadoFicha({oferta: null}), 'sin_oferta');
  assert.equal(estadoFicha({oferta: {price: 1}}), 'ofrece');
});

test('cambioDePrecio solo avisa por más del 5 %', () => {
  assert.equal(cambioDePrecio(1000, 1040), null);
  assert.ok(cambioDePrecio(1000, 1060) > 0.05);
  assert.ok(cambioDePrecio(1000, 900) < -0.05);
  assert.equal(cambioDePrecio(null, 900), null);
});

test('fallaGeneral frena cuando casi todas desaparecen', () => {
  assert.equal(fallaGeneral(Array(30).fill('sin_oferta')), true);
  assert.equal(fallaGeneral([...Array(28).fill('ofrece'), 'sin_oferta', 'sin_oferta']), false);
  assert.equal(fallaGeneral(['sin_oferta', 'sin_oferta']), false);
});

function mlFalso({ofrecen, items = {}}) {
  const puts = [];
  return {puts, get: async p => {
    const m = p.match(/\/products\/(MLU\d+)\/items/);
    if (m) return {paging: {total: 1}, results: ofrecen.includes(m[1]) ? [{seller_id: 471589392, price: 1000, item_id: 'MLU1'}] : [{seller_id: 9, price: 500}]};
    const it = p.match(/\/items\/(MLU\d+)$/)?.[1];
    return items[it] ?? null;
  }, put: async (p, b) => { puts.push([p, b]); items[p.split('/').pop()] = {...items[p.split('/').pop()], status: b.status}; return {}; }};
}
const fichas = n => Array.from({length: n}, (_, i) => ({n: i + 1, titulo: `L${i + 1}`, producto: `MLU${100 + i}`, mi_mlu: i === 0 ? 'MLU900' : null}));

test('pausa la publicación mía solo si Hermes dejó de ofrecer y es de Amado Libros', async () => {
  const f = fichas(25);
  const ml = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 440298103, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: true, ml, pausaMs: 0});
  assert.equal(r.pausadas.length, 1);
  assert.deepEqual(ml.puts, [['/items/MLU900', {status: 'paused'}]]);
  assert.match(r.resumen, /1 sin oferta/);
});

test('sin --real no pausa y no toca publicaciones de otra cuenta', async () => {
  const f = fichas(25);
  const ml = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 440298103, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: false, ml, pausaMs: 0});
  assert.equal(ml.puts.length, 0);
  assert.equal(r.pausadas[0].resultado, 'se_pausaria');
  const ml2 = mlFalso({ofrecen: f.slice(1).map(x => x.producto), items: {MLU900: {seller_id: 123, status: 'active'}}});
  const r2 = await correr({fichas: f, historial: [], real: true, ml: ml2, pausaMs: 0});
  assert.equal(ml2.puts.length, 0);
  assert.equal(r2.pausadas[0].resultado, 'no_es_de_amado_libros_no_se_toca');
});

test('si casi todas desaparecen de golpe no pausa nada', async () => {
  const f = fichas(30);
  const ml = mlFalso({ofrecen: [], items: {MLU900: {seller_id: 440298103, status: 'active'}}});
  const r = await correr({fichas: f, historial: [], real: true, ml, pausaMs: 0});
  assert.equal(r.falla, true);
  assert.equal(ml.puts.length, 0);
});

test('detecta cambio de precio contra el historial', async () => {
  const f = fichas(1).map(x => ({...x, mi_mlu: null}));
  const ml = mlFalso({ofrecen: [f[0].producto]});
  const r = await correr({fichas: f, historial: [{fecha: '2026-11-17', producto: f[0].producto, precio: 800}], real: false, ml, pausaMs: 0});
  assert.equal(r.cambios.length, 1);
  assert.match(r.resumen, /de \$800 a \$1000/);
});
