import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, parseArgs, parseTitulos, runPromos } from '../mercadolibre/promos.mjs';

// Worker simulado: responde como /meli-promos y registra cada pedido.
function fakeWorker({ promotions, itemsByPromo, itemPromos, status = 200, statusBody } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.action === 'status') {
      if (statusBody) return Response.json(statusBody, { status });
      return Response.json({ seller_id: '440298103', action: 'status', ok: true, ml_status: 200, promotions });
    }
    if (body.action === 'promo_items') {
      const rows = (itemsByPromo?.[body.promotion_id] ?? []).filter(r => !body.status || r.status === body.status);
      return Response.json({ ok: true, ml_status: 200, items: rows, total: rows.length, search_after: null });
    }
    if (body.action === 'item_promos') {
      return Response.json({ ok: true, items: body.ids.map(id => ({ id, ...(itemPromos?.[id] ?? { price: 800, available_quantity: 5, promotions: [] }) })), failed: [] });
    }
    if (body.action === 'remove') return Response.json({ ok: true, results: body.removals.map(r => ({ item_id: r.item_id, promotion_id: r.promotion_id, ok: true, ml_status: 200 })) });
    if (body.action === 'join_lightning') return Response.json({ ok: true, results: body.joins.map(j => ({ item_id: j.item_id, promotion_id: j.promotion_id, ok: true, ml_status: 200 })) });
    return Response.json({ error: 'x' }, { status: 400 });
  };
  return { calls, client: createClient({ secret: 's', fetcher, wait: async () => {} }) };
}

const PROMOS = [
  { id: 'P-1', type: 'DEAL', status: 'started', name: 'Semana del libro' },
  { id: 'P-2', type: 'PRICE_DISCOUNT', status: 'pending', name: 'Programada' },
  { id: 'P-3', type: 'SELLER_COUPON_CAMPAIGN', status: 'started', name: 'Cupón' },
  { id: 'P-4', type: 'DEAL', status: 'finished', name: 'Vieja' },
];
const ROWS = {
  'P-1': [
    { id: 'MLU1', status: 'started', price: 700, original_price: 1000 },
    { id: 'MLU2', status: 'started', price: 900, original_price: 1000 },
    { id: 'MLU9', status: 'finished', price: 500, original_price: 1000 },
  ],
  'P-2': [{ id: 'MLU3', status: 'pending', price: 800, original_price: 1000 }],
};
const opts = (over = {}) => ({ accion: 'auditar', maxPct: 16, confirm: false, titulos: [], date: '2026-11-05', ...over });
const writes = calls => calls.filter(c => c.action === 'remove' || c.action === 'join_lightning');

test('parseArgs usa 16 por defecto y confirm apagado', () => {
  const a = parseArgs(['--accion', 'auditar', '--out', 'x.json']);
  assert.equal(a.maxPct, 16);
  assert.equal(a.confirm, false);
  assert.equal(parseArgs(['--accion', 'aplicar_tope', '--confirm', 'true', '--max', '14']).confirm, true);
  assert.equal(parseArgs(['--accion', 'aplicar_tope', '--confirm', 'false']).confirm, false);
  assert.throws(() => parseArgs(['--accion', 'borrar']), /acci/i);
  assert.throws(() => parseArgs(['--accion', 'auditar', '--max', '-3']), /max/i);
});

test('parseTitulos acepta MLU separados por coma, espacio o línea y descarta repetidos', () => {
  assert.deepEqual(parseTitulos('MLU1, MLU2\nMLU3  mlu2'), ['MLU1', 'MLU2', 'MLU3']);
  assert.throws(() => parseTitulos('MLU1 hola'), /hola/);
  assert.deepEqual(parseTitulos(''), []);
});

test('auditar: lista promos activas y programadas con su %, devuelve las que superan el máximo y no escribe', async () => {
  const w = fakeWorker({ promotions: PROMOS, itemsByPromo: ROWS });
  const res = await runPromos(opts(), w.client);
  assert.equal(res.acceso.ok, true);
  assert.equal(res.resumen.promociones_activas_o_programadas, 2);
  assert.equal(res.resumen.publicaciones_en_promo, 3);
  assert.deepEqual(res.superan.map(e => [e.item_id, e.discount_pct]).sort(), [['MLU1', 30], ['MLU3', 20]]);
  assert.equal(res.promociones_excluidas.length, 1);
  assert.equal(writes(w.calls).length, 0);
});

test('auditar con confirm=true tampoco escribe', async () => {
  const w = fakeWorker({ promotions: PROMOS, itemsByPromo: ROWS });
  await runPromos(opts({ confirm: true }), w.client);
  assert.equal(writes(w.calls).length, 0);
});

test('un 403 de Mercado Libre queda informado como falta de permiso y no sigue', async () => {
  const w = fakeWorker({ statusBody: { seller_id: '440298103', action: 'status', ok: false, ml_status: 403, error: 'ml_forbidden' } });
  const res = await runPromos(opts(), w.client);
  assert.equal(res.acceso.ok, false);
  assert.equal(res.acceso.ml_status, 403);
  assert.match(res.acceso.mensaje, /re-?autoriz/i);
  assert.equal(w.calls.length, 1);
});

test('aplicar_tope en dry-run arma el plan pero no manda ninguna escritura', async () => {
  const w = fakeWorker({ promotions: PROMOS, itemsByPromo: ROWS });
  const res = await runPromos(opts({ accion: 'aplicar_tope' }), w.client);
  assert.equal(res.dry_run, true);
  assert.deepEqual(res.plan.removals.map(r => r.item_id).sort(), ['MLU1', 'MLU3']);
  assert.equal(writes(w.calls).length, 0);
});

test('aplicar_tope con confirm saca solo lo planificado y verifica', async () => {
  const w = fakeWorker({ promotions: PROMOS, itemsByPromo: ROWS });
  const res = await runPromos(opts({ accion: 'aplicar_tope', confirm: true }), w.client);
  assert.equal(res.dry_run, false);
  const sent = writes(w.calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'remove');
  assert.equal(sent[0].confirm, true);
  assert.deepEqual(sent[0].removals.map(r => r.item_id).sort(), ['MLU1', 'MLU3']);
  assert.ok(sent[0].removals.every(r => Object.keys(r).sort().join() === 'item_id,promotion_id,promotion_type'));
  assert.equal(res.aplicado.length, 2);
  assert.ok(res.aplicado.every(r => r.ok && r.verificado === true));
});

test('aplicar_tope no toca cupones ni la promo de liquidación', async () => {
  const promos = [...PROMOS, { id: 'P-5', type: 'DEAL', status: 'started', name: 'Amado Liquidacion 40/30/20' }];
  const rows = { ...ROWS, 'P-5': [{ id: 'MLU7', status: 'started', price: 600, original_price: 1000 }] };
  const w = fakeWorker({ promotions: promos, itemsByPromo: rows });
  const res = await runPromos(opts({ accion: 'aplicar_tope', confirm: true }), w.client);
  assert.ok(!writes(w.calls).flatMap(c => c.removals).some(r => r.item_id === 'MLU7'));
  assert.deepEqual(res.plan.skipped.map(s => [s.item_id, s.reason]), [['MLU7', 'liquidacion_no_se_toca']]);
});

test('relampago: exige títulos, en dry-run solo planifica y con confirm suma', async () => {
  const lightning = { id: 'L-1', type: 'LIGHTNING', status: 'candidate', original_price: 1000, min_discounted_price: 700, max_discounted_price: 860, min_stock: 2 };
  const itemPromos = { MLU1: { price: 950, available_quantity: 6, promotions: [lightning] }, MLU2: { price: 950, available_quantity: 6, promotions: [{ ...lightning, max_discounted_price: 790 }] } };
  const w = fakeWorker({ promotions: [{ id: 'L-1', type: 'LIGHTNING', status: 'pending', name: 'Relámpago del día' }], itemPromos });
  await assert.rejects(() => runPromos(opts({ accion: 'relampago' }), w.client), /titulos/i);

  const dry = await runPromos(opts({ accion: 'relampago', titulos: ['MLU1', 'MLU2'] }), w.client);
  assert.equal(dry.dry_run, true);
  assert.deepEqual(dry.plan.joins.map(j => j.item_id), ['MLU1']);
  assert.equal(dry.plan.skipped[0].reason, 'ml_exige_mas_descuento_que_el_maximo');
  assert.equal(writes(w.calls).length, 0);

  const real = await runPromos(opts({ accion: 'relampago', titulos: ['MLU1', 'MLU2'], confirm: true }), w.client);
  const sent = writes(w.calls);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, 'join_lightning');
  assert.deepEqual(sent[0].joins.map(j => [j.item_id, j.deal_price, j.stock]), [['MLU1', 860, 2]]);
  assert.equal(real.aplicado[0].ok, true);
});

test('si el Worker todavía no tiene la ruta, el error lo dice claro', async () => {
  const client = createClient({ secret: 's', fetcher: async () => Response.json({ error: 'Not found' }, { status: 404 }), wait: async () => {} });
  await assert.rejects(() => runPromos(opts(), client), /desplegar/i);
});

test('el cliente reintenta lecturas con 5xx pero nunca reintenta escrituras', async () => {
  let reads = 0, writesSeen = 0;
  const fetcher = async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.action === 'status') { reads += 1; return reads < 3 ? new Response('{}', { status: 502 }) : Response.json({ ok: true }); }
    writesSeen += 1;
    return new Response('{}', { status: 502 });
  };
  const client = createClient({ secret: 's', fetcher, wait: async () => {} });
  assert.equal((await client.call('status')).ok, true);
  assert.equal(reads, 3);
  await assert.rejects(() => client.call('remove', { confirm: true, removals: [] }));
  assert.equal(writesSeen, 1);
});
