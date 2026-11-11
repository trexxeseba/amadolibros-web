import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buscarPromo, entradaEnPromo, precioObjetivo, cuerpoPost, cuponesVigentes, unidadesPorItem, armarSeleccion, gastoDelMes, primerDiaDelMes, bucketPct } from '../src/promos-logica.mjs';
import { LIMITES, evaluarEscritura, aplicarPedidoSeba, evaluarGastoAds } from '../src/guardas.mjs';

const promos = [
  { id: 'P-MLU1', type: 'SELLER_CAMPAIGN', status: 'started', name: 'Amado 15' },
  { id: 'P-MLU2', type: 'DEAL', status: 'started', name: 'Ciberlunes' },
  { id: 'P-MLU3', type: 'DEAL', status: 'pending', name: 'Ciberlunes Noviembre' },
  { id: 'P-MLU4', type: 'SELLER_COUPON_CAMPAIGN', status: 'started', name: 'AMADO300' },
  { id: 'P-MLU5', type: 'SELLER_COUPON_CAMPAIGN', status: 'finished', name: 'AMADO500' },
];

test('buscar promo por nombre: exacta sin tildes; parcial única; ambigua o inexistente frena', () => {
  assert.equal(buscarPromo(promos, 'amado 15').promo.id, 'P-MLU1');
  assert.equal(buscarPromo(promos, 'Ciberlunes').promo.id, 'P-MLU2', 'la exacta gana sobre la parcial');
  assert.equal(buscarPromo(promos, 'noviembre').promo.id, 'P-MLU3');
  assert.equal(buscarPromo(promos, 'ciber').error, 'ambiguo');
  assert.equal(buscarPromo(promos, 'Amado Week').error, 'no_encontrada');
  assert.equal(buscarPromo(promos, '').error, 'nombre_vacio');
});

test('entrada del ítem en la promo: por id; PRICE_DISCOUNT sin id se encuentra por tipo', () => {
  const entradas = [{ id: 'P-MLU1', type: 'SELLER_CAMPAIGN', status: 'candidate', max_discounted_price: 2090 }, { type: 'PRICE_DISCOUNT', status: 'candidate' }];
  assert.equal(entradaEnPromo(entradas, promos[0]).max_discounted_price, 2090);
  assert.equal(entradaEnPromo(entradas, { id: 'X', type: 'PRICE_DISCOUNT' }).type, 'PRICE_DISCOUNT');
  assert.equal(entradaEnPromo(entradas, promos[1]), null);
});

test('precio objetivo: el pedido respeta el rango de la promo; sin pedido usa sugerido, máximo o fijo', () => {
  const e = { min_discounted_price: 1870, max_discounted_price: 2090, suggested_discounted_price: 1980 };
  assert.deepEqual(precioObjetivo({ entrada: e, precioPedido: 2090 }), { precio: 2090, fuente: 'pedido' });
  assert.equal(precioObjetivo({ entrada: e, precioPedido: 2100 }).error, 'precio_sobre_el_maximo');
  assert.equal(precioObjetivo({ entrada: e, precioPedido: 1000 }).error, 'precio_bajo_el_minimo');
  assert.deepEqual(precioObjetivo({ entrada: e }), { precio: 1980, fuente: 'sugerido' });
  assert.deepEqual(precioObjetivo({ entrada: { max_discounted_price: 2090 } }), { precio: 2090, fuente: 'maximo' });
  // Entrada real de Amado 15 (11/11): price 0 con rango. El 0 no es un precio fijado: va el sugerido.
  const amado15 = { id: 'C-MLU1040790', type: 'SELLER_CAMPAIGN', status: 'candidate', price: 0, original_price: 2200, min_discounted_price: 765.6, max_discounted_price: 2090, suggested_discounted_price: 2090 };
  assert.deepEqual(precioObjetivo({ entrada: amado15 }), { precio: 2090, fuente: 'sugerido' });
  assert.deepEqual(precioObjetivo({ entrada: amado15, precioPedido: 2090 }), { precio: 2090, fuente: 'pedido' });
  assert.equal(precioObjetivo({ entrada: { price: 0 } }).error, 'sin_precio');
  assert.deepEqual(precioObjetivo({ entrada: { price: 1500, offer_id: 'C-1' } }), { precio: 1500, fuente: 'fijado_por_ml' });
  assert.equal(precioObjetivo({ entrada: { price: 1500 }, precioPedido: 1400 }).error, 'precio_fijado_por_ml');
  assert.equal(precioObjetivo({ entrada: null, precioActual: 2200 }).error, 'sin_rango_de_precio');
  assert.equal(precioObjetivo({ entrada: null, precioPedido: 0 }).error, 'precio_invalido');
});

test('cuerpo del POST: promotion_id, promotion_type y deal_price; offer_id sólo en SMART', () => {
  assert.deepEqual(cuerpoPost(promos[0], 2090), { promotion_id: 'P-MLU1', promotion_type: 'SELLER_CAMPAIGN', deal_price: 2090 });
  assert.deepEqual(cuerpoPost({ id: 'P-9', type: 'SMART' }, 900, { offer_id: 'CANDIDATE-1' }), { promotion_id: 'P-9', promotion_type: 'SMART', deal_price: 900, offer_id: 'CANDIDATE-1' });
});

test('cupones vigentes: monto de los items de cada campaña de cupón', () => {
  const c = cuponesVigentes(promos, { 'P-MLU4': { fixed_amount: 300 } });
  assert.deepEqual(c.map(x => [x.id, x.status, x.fixed_amount]), [['P-MLU4', 'started', 300], ['P-MLU5', 'finished', null]]);
});

test('pedido expreso de Seba: salta competencia, antigüedad y lista manual; no salta stock ni médico ni límites', () => {
  const base = { modo: 'real', ahora: new Date('2026-11-11T12:00:00Z'), config: { items: ['MLU706638240'], palabras_medicas: ['farmacologia'] }, item: { id: 'MLU706638240', title: 'Gold Foil Tarot', available_quantity: 4, date_created: '2026-10-01T00:00:00.000Z' }, venta: { amount: 2200, regular_amount: null }, promo: { id: 'P-MLU1', type: 'SELLER_CAMPAIGN', name: 'Amado 15', price: 2090 }, cupon: { monto: 500 }, competencia: { status: 'winning' } };
  const r = evaluarEscritura('unirse_promo', base);
  assert.deepEqual(r.fallas.map(f => f.guarda).sort(), ['gana_el_catalogo', 'item_nuevo', 'lista_manual']);
  const s = aplicarPedidoSeba(r);
  assert.equal(s.permitido, true);
  assert.deepEqual(s.saltadas.sort(), ['gana_el_catalogo', 'item_nuevo', 'lista_manual']);
  assert.equal(aplicarPedidoSeba(evaluarEscritura('unirse_promo', { ...base, item: { ...base.item, available_quantity: 2 } })).permitido, false, 'stock 2 no se salta');
  assert.equal(aplicarPedidoSeba(evaluarEscritura('unirse_promo', { ...base, item: { ...base.item, title: 'Farmacología' } })).permitido, false, 'libro médico no se salta');
  assert.equal(aplicarPedidoSeba(evaluarEscritura('unirse_promo', { ...base, promo: { ...base.promo, price: 1800 } })).permitido, false, '18 % visible no se salta');
});

test('Gold Foil Tarot: 5 % en Amado 15 (2.090 sobre 2.200) pasa con cupón de 500: promo + cupón = 610', () => {
  const r = evaluarEscritura('unirse_promo', { modo: 'real', ahora: new Date('2026-11-11T12:00:00Z'), config: {}, item: { id: 'MLU706638240', title: 'Gold Foil Tarot', available_quantity: 3, date_created: '2024-01-01T00:00:00.000Z' }, venta: { amount: 2200, regular_amount: null }, promo: { id: 'P-MLU1', type: 'SELLER_CAMPAIGN', name: 'Amado 15', price: 2090 }, cupon: { monto: 500 }, competencia: { status: 'not_listed', reason: ['item_not_opted_in'] } });
  assert.deepEqual(r, { permitido: true, fallas: [], alerta: false });
});

test('unidades por ítem: suma cantidades y salta canceladas', () => {
  const m = unidadesPorItem([
    { status: 'paid', order_items: [{ item: { id: 'MLU1' }, quantity: 2 }, { item: { id: 'MLU2' }, quantity: 1 }] },
    { status: 'cancelled', order_items: [{ item: { id: 'MLU1' }, quantity: 5 }] },
    { status: 'paid', order_items: [{ item: { id: 'MLU1' }, quantity: 1 }] },
  ]);
  assert.deepEqual([...m.entries()], [['MLU1', 3], ['MLU2', 1]]);
});

test('selección: ventas mandan, visitas desempatan; fuera stock bajo, médicos, lista manual, ya en promo, sin ventas', () => {
  const items = [
    { id: 'MLU1', title: 'A', status: 'active', available_quantity: 5, price: 1000 },
    { id: 'MLU2', title: 'B', status: 'active', available_quantity: 5, price: 1000 },
    { id: 'MLU3', title: 'Farmacología', status: 'active', available_quantity: 5, price: 1000 },
    { id: 'MLU4', title: 'D', status: 'active', available_quantity: 2, price: 1000 },
    { id: 'MLU5', title: 'E', status: 'paused', available_quantity: 5, price: 1000 },
    { id: 'MLU6', title: 'F', status: 'active', available_quantity: 5, price: 1000 },
    { id: 'MLU7', title: 'G', status: 'active', available_quantity: 5, price: 1000 },
    { id: 'MLU8', title: 'H', status: 'active', available_quantity: 5, price: 1000 },
  ];
  const unidades = new Map([['MLU1', 3], ['MLU2', 3], ['MLU3', 9], ['MLU4', 9], ['MLU5', 9], ['MLU6', 9], ['MLU7', 1]]);
  const visitas = new Map([['MLU1', 10], ['MLU2', 50]]);
  const r = armarSeleccion({ items, unidades, visitas, config: { items: ['MLU7'], palabras_medicas: ['farmacologia'] }, enPromo: new Set(['MLU6']), limite: 50 });
  assert.deepEqual(r.seleccion.map(s => s.id), ['MLU2', 'MLU1']);
  assert.deepEqual(r.fuera, { libro_medico: 1, stock_bajo: 1, no_activo: 1, ya_en_promo: 1, lista_manual: 1, sin_ventas: 1 });
  assert.equal(armarSeleccion({ items, unidades, visitas, limite: 1 }).seleccion.length, 1);
});

test('gasto de Ads del mes y tope de $20.000: dentro, alerta desde 80 %, superado, no leído', () => {
  assert.equal(LIMITES.adsMensualMaxUyu, 20000);
  assert.equal(gastoDelMes({ metrics_summary: { cost: 1234.5 }, results: [] }), 1234.5);
  assert.equal(gastoDelMes({ results: [{ metrics: { cost: 100.25 } }, { metrics: { cost: 50 } }, { metrics: {} }] }), 150.25);
  assert.equal(gastoDelMes({ results: [] }), null);
  assert.deepEqual(evaluarGastoAds(5000), { estado: 'dentro', pct: 25, tope: 20000, restante: 15000 });
  assert.equal(evaluarGastoAds(16000).estado, 'alerta');
  assert.equal(evaluarGastoAds(20000.01).estado, 'superado');
  assert.equal(evaluarGastoAds(null).estado, 'no_leido');
  assert.equal(evaluarGastoAds(25000, 30000).estado, 'alerta', 'el tope viejo de 30.000 ya no es el default');
  assert.equal(primerDiaDelMes('2026-11-11'), '2026-11-01');
  assert.equal(bucketPct(27.3), '25-30%');
  assert.equal(bucketPct(null), null);
});

test('Product Ads sigue sin escritura por API, también desde el job', () => {
  assert.equal(evaluarEscritura('ads', { modo: 'real' }).permitido, false);
});
