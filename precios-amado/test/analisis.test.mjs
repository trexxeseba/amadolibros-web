import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertasCatalogo, oportunidades } from '../src/analisis.mjs';
import { clasificar } from '../src/competencia.mjs';
import { manufacturingDays, configIssues } from '../src/publicaciones.mjs';

const propio = (over = {}) => ({ id: 'MLU1', titulo: 'Libro', enlace: 'https://x', isbn: '9789501203998', precio: 1000, moneda: 'UYU', estado: 'active', disponible: 3, condicion: 'new', catalogo: true, producto_catalogo: 'MLU19864611', plazo_dias: 0, relaciones: [], ...over });
const oferta = (over = {}) => ({ item_id: 'MLU9', vendedor: '1', precio: 800, moneda: 'UYU', condicion: 'new', internacional: false, plazo_dias: 20, plazo_fuente: 'items/bulk', estado: 'active', disponible: 2, enlace: 'https://y', ...over });
const resultado = (over = {}) => ({ item: propio(), pid: 'MLU19864611', consulta: { fecha: '2026-11-03T12:00:00.000Z', completa: true, error: null }, ofertas: [], comparables: [], excluidas: 0, estado: 'sin_competidores', ptw: { ok: true, data: { status: 'winning', winner: { item_id: 'MLU1' } } }, ...over });

test('alerta principal: pierde frente a un ganador más barato con plazo', () => {
  const o = oferta();
  const r = resultado({ ofertas: [o], comparables: [o], estado: 'solo_con_plazo', ptw: { ok: true, data: { status: 'losing', winner: { item_id: 'MLU9', price: 800 }, price_to_win: 799, reason: ['price'], boosts: [] } } });
  const { pierde, decidir } = alertasCatalogo(new Map([['MLU1', r]]));
  assert.equal(pierde.length, 1); assert.equal(decidir.length, 0);
  assert.equal(pierde[0].diferencia, -200);
  assert.match(pierde[0].plazo_texto, /20 días/);
  assert.match(pierde[0].texto, /no es una orden|decidir/i);
});

test('ganador más barato sin plazo declarado no es la alerta principal: va a decidir', () => {
  const o = oferta({ plazo_dias: 0 });
  const r = resultado({ ofertas: [o], comparables: [o], estado: 'con_sin_plazo_declarado', ptw: { ok: true, data: { status: 'losing', winner: { item_id: 'MLU9', price: 800 }, reason: [] } } });
  const { pierde, decidir } = alertasCatalogo(new Map([['MLU1', r]]));
  assert.equal(pierde.length, 0); assert.equal(decidir.length, 1);
  assert.match(decidir[0].texto, /no tiene plazo de preparación/);
});

test('error al leer price_to_win no produce alerta ni oportunidad', () => {
  const r = resultado({ ptw: { ok: false, error: 'http_500' }, estado: 'sin_competidores' });
  const { pierde, decidir } = alertasCatalogo(new Map([['MLU1', r]]));
  assert.equal(pierde.length, 0); assert.equal(decidir[0].tipo, 'competencia_sin_estado');
});

test('consulta fallida queda insuficiente: nunca "sin competidores"', () => {
  const r = resultado({ estado: 'insuficiente', consulta: { fecha: 'x', completa: false, error: 'http_500' } });
  assert.equal(oportunidades(new Map([['MLU1', r]])).length, 0);
});

test('oportunidad con importe: sólo con referencia respaldada (dos vendedores o techo)', () => {
  const uno = oferta({ precio: 1300 });
  const [solo] = oportunidades(new Map([['MLU1', resultado({ ofertas: [uno], comparables: [uno], estado: 'solo_con_plazo' })]]));
  assert.equal(solo.sugerido, null); assert.match(solo.motivo, /un solo vendedor/);
  const a = oferta({ precio: 1300, vendedor: '1' }), b = oferta({ item_id: 'MLU8', precio: 1400, vendedor: '2' });
  const [dos] = oportunidades(new Map([['MLU1', resultado({ ofertas: [a, b], comparables: [a, b], estado: 'solo_con_plazo' })]]));
  assert.equal(dos.sugerido, 1300); assert.equal(dos.referencia.vendedores, 2);
  const x = oferta({ precio: 9000, vendedor: '1' }), y = oferta({ item_id: 'MLU8', precio: 9500, vendedor: '2' });
  const [lejos] = oportunidades(new Map([['MLU1', resultado({ ofertas: [x, y], comparables: [x, y], estado: 'solo_con_plazo' })]]));
  // Sin tope inventado: dos vendedores lo respaldan; la diferencia se muestra en %.
  assert.equal(lejos.sugerido, 9000); assert.equal(lejos.diferencia_pct, 800);
});

test('oportunidad con techo: el techo acota el importe', () => {
  const caro = oferta({ precio: 1300 }), barato = oferta({ item_id: 'MLU8', precio: 900 });
  const r1 = resultado({ ofertas: [caro], comparables: [caro], estado: 'solo_con_plazo', ptw: { ok: true, data: { status: 'winning', winner: { item_id: 'MLU1' } } } });
  const [op] = oportunidades(new Map([['MLU1', r1]]), { techos: { MLU1: 1200 } });
  assert.equal(op.sugerido, 1200); // acotado por el techo
  // Ya cobramos más que el a pedido: no es oportunidad, se cuenta aparte.
  const r2 = resultado({ ofertas: [barato], comparables: [barato], estado: 'solo_con_plazo' });
  const ops2 = oportunidades(new Map([['MLU1', r2]]));
  assert.equal(ops2.length, 0); assert.equal(ops2.yaArriba.length, 1);
});

test('sin stock, con plazo propio o perdiendo en catálogo no hay oportunidad', () => {
  const r = resultado({ item: propio({ disponible: 0 }) });
  assert.equal(oportunidades(new Map([['a', r]])).length, 0);
  const r2 = resultado({ item: propio({ plazo_dias: 5 }) });
  assert.equal(oportunidades(new Map([['b', r2]])).length, 0);
  const r3 = resultado({ ptw: { ok: true, data: { status: 'losing', winner: { item_id: 'MLU9', price: 500 } } } });
  assert.equal(oportunidades(new Map([['c', r3]])).length, 0);
});

test('máximo observado se informa como histórico y no cambia el sugerido', () => {
  const r = resultado();
  const [op] = oportunidades(new Map([['MLU1', r]]), { historial: { MLU1: { max_precio: 1500, max_fecha: '2026-10-01', desde: '2026-10-01' } } });
  assert.equal(op.maximo_observado.precio, 1500); assert.equal(op.sugerido, null);
});

test('clasificar: mismo libro, condición y nacionales; usados e internacionales quedan fuera', () => {
  const ofertas = [oferta({ vendedor: '440298103' }), oferta({ condicion: 'used' }), oferta({ internacional: true }), oferta({ item_id: 'MLU7', plazo_dias: 0 })];
  const c = clasificar(ofertas, propio());
  assert.equal(c.total_ajenas, 3); assert.equal(c.comparables.length, 1); assert.equal(c.excluidas, 2); assert.equal(c.estado, 'con_sin_plazo_declarado');
  assert.equal(clasificar([oferta({ vendedor: '440298103' })], propio()).estado, 'sin_competidores');
  assert.equal(clasificar([oferta()], propio()).estado, 'solo_con_plazo');
  assert.equal(clasificar([oferta({ plazo_dias: null, plazo_fuente: null })], propio()).estado, 'plazo_no_verificado');
  // Condición desconocida: cuenta como competidor y no cierra el caso.
  assert.equal(clasificar([oferta({ condicion: null })], propio()).estado, 'plazo_no_verificado');
  assert.equal(clasificar([oferta({ condicion: null }), oferta({ item_id: 'MLU5', plazo_dias: 0 })], propio()).estado, 'con_sin_plazo_declarado');
});

test('plazo de preparación: unidades y ausencias', () => {
  assert.equal(manufacturingDays({ sale_terms: [] }), 0);
  assert.equal(manufacturingDays({}), null);
  assert.equal(manufacturingDays({ sale_terms: [{ id: 'MANUFACTURING_TIME', value_struct: { number: 20, unit: 'días' } }] }), 20);
  assert.equal(manufacturingDays({ sale_terms: [{ id: 'MANUFACTURING_TIME', value_struct: { number: 2, unit: 'semanas' } }] }), 14);
  assert.equal(manufacturingDays({ sale_terms: [{ id: 'MANUFACTURING_TIME', value_name: '15 días' }] }), 15);
});

test('errores de configuración propios', () => {
  const tipos = configIssues([propio({ plazo_dias: 10, disponible: 0, isbn: null })]).map(e => e.tipo);
  assert.deepEqual(tipos.sort(), ['plazo_configurado', 'sin_isbn', 'sin_stock']);
});

test('catálogo y tradicional gemela: una oportunidad por ficha, ninguna si perdemos la destacada', async () => {
  const { agruparPorFicha } = await import('../src/analisis.mjs');
  const cat = resultado({ item: propio({ id: 'MLUC', catalogo: true }), ptw: { ok: true, data: { status: 'winning', winner: { item_id: 'MLUC' } } } });
  const trad = resultado({ item: propio({ id: 'MLUT', catalogo: false }) });
  const res = new Map([['MLUC', cat], ['MLUT', trad]]);
  const ops = agruparPorFicha(oportunidades(res), res);
  assert.equal(ops.length, 1); assert.equal(ops[0].item.id, 'MLUC'); assert.deepEqual(ops[0].gemelas, ['MLUT']);
  const perdiendo = resultado({ item: propio({ id: 'MLUC', catalogo: true }), ptw: { ok: true, data: { status: 'losing', winner: { item_id: 'MLU9', price: 500 } } } });
  const res2 = new Map([['MLUC', perdiendo], ['MLUT', trad]]);
  assert.equal(agruparPorFicha(oportunidades(res2), res2).length, 0);
});

test('opciones de envío: preparación y llegada por separado; sin opciones no es inmediata', async () => {
  const { leerEnvio } = await import('../src/competencia.mjs');
  const { plazoTexto } = await import('../src/analisis.mjs');
  const env = leerEnvio({ options: [{ estimated_delivery_time: { schedule: 552, date: '2026-11-30T00:00:00-03:00', handling: 0, shipping: 72 } }, { estimated_delivery_time: { schedule: 552, date: '2026-12-01T00:00:00-03:00' } }] });
  assert.equal(env.plazo_dias, 23); assert.equal(env.llegada, '2026-11-30T00:00:00-03:00'); assert.equal(env.sin_envio, false);
  // Igual que nuestro control: schedule null y handling <= 24 h → sin preparación.
  assert.equal(leerEnvio({ options: [{ estimated_delivery_time: { schedule: null, date: '2026-11-04T00:00:00-03:00', handling: 24, unit: 'hour' } }] }).plazo_dias, 0);
  // Sin schedule ni handling, o handling largo: desconocido, nunca inmediata.
  assert.equal(leerEnvio({ options: [{ estimated_delivery_time: { date: '2026-11-20' } }] }).plazo_dias, null);
  assert.equal(leerEnvio({ options: [{ estimated_delivery_time: { schedule: null, handling: 96, date: '2026-11-20' } }] }).plazo_dias, null);
  // Se prefiere la opción recomendada.
  assert.equal(leerEnvio({ options: [{ display: 'optional', estimated_delivery_time: { schedule: null, handling: 0 } }, { display: 'recommended', estimated_delivery_time: { schedule: 360 } }] }).plazo_dias, 15);
  assert.equal(leerEnvio({ options: [] }).sin_envio, true);
  assert.equal(leerEnvio({}), null);
  assert.equal(plazoTexto({ plazo_dias: 23, llegada: '2026-11-30T00:00:00-03:00', destino: 'Cordón, Montevideo' }), '23 días de preparación; llegada estimada 30/11 a Cordón, Montevideo');
  const c = clasificar([oferta({ plazo_dias: 0, sin_envio: true, plazo_fuente: 'shipping_options' })], propio());
  assert.equal(c.estado, 'plazo_no_verificado');
});

test('alertas: ganador propio, primer lugar compartido y "listed" no son "perdemos"', () => {
  const o = oferta();
  const res = new Map([
    ['MLU1', resultado({ ofertas: [o], comparables: [o], ptw: { ok: true, data: { status: 'competing', winner: { item_id: 'MLU2', price: 800 } } } })],
    ['MLU2', resultado({ item: propio({ id: 'MLU2' }) })],
  ]);
  const a = alertasCatalogo(res);
  assert.equal(a.pierde.length + a.decidir.length, 0);
  const comp = alertasCatalogo(new Map([['MLU1', resultado({ ptw: { ok: true, data: { status: 'sharing_first_place', competitors_sharing_first_place: 2, price_to_win: 990 } } })]]));
  assert.equal(comp.pierde.length, 0); assert.equal(comp.decidir[0].tipo, 'comparte_primer_lugar');
  const lst = alertasCatalogo(new Map([['MLU1', resultado({ ptw: { ok: true, data: { status: 'listed', reason: ['reputation_below_threshold'] } } })]]));
  assert.equal(lst.decidir[0].tipo, 'no_compite'); assert.match(lst.decidir[0].texto, /reputación/);
});

test('alerta principal exige que nuestra publicación sea inmediata comprobada', () => {
  const o = oferta();
  const ptw = { ok: true, data: { status: 'competing', winner: { item_id: 'MLU9', price: 800 } } };
  const conPlazo = alertasCatalogo(new Map([['MLU1', resultado({ item: propio({ plazo_dias: 15 }), ofertas: [o], ptw })]]));
  assert.equal(conPlazo.pierde.length, 0); assert.equal(conPlazo.decidir[0].tipo, 'pierde_con_plazo_propio_no_inmediato');
  const sinLeer = oportunidades(new Map([['MLU1', resultado({ item: propio({ plazo_dias: null }) })]]));
  assert.equal(sinLeer.length, 0);
  // Sin motivo de ML, el primer paso es soporte.
  const ok = alertasCatalogo(new Map([['MLU1', resultado({ ofertas: [o], ptw })]]));
  assert.match(ok.pierde[0].texto, /soporte/);
});

test('inmediatos ajenos que cobran más que nosotros: oportunidad con referencia inmediata', () => {
  const a = oferta({ plazo_dias: 0, precio: 1200, vendedor: '1' }), b = oferta({ item_id: 'MLU8', plazo_dias: 0, precio: 1250, vendedor: '2' });
  const [op] = oportunidades(new Map([['MLU1', resultado({ ofertas: [a, b], comparables: [a, b], estado: 'con_sin_plazo_declarado' })]]));
  assert.equal(op.referencia.tipo, 'inmediato'); assert.equal(op.sugerido, 1200);
  const c = oferta({ plazo_dias: 0, precio: 950 });
  assert.equal(oportunidades(new Map([['MLU1', resultado({ ofertas: [a, c], comparables: [a, c], estado: 'con_sin_plazo_declarado' })]])).length, 0);
});

test('gemelas: la tradicional no es oportunidad si su catálogo no gana; precios distintos se avisan', async () => {
  const { agruparPorFicha, gemelasDesincronizadas } = await import('../src/analisis.mjs');
  const cat = resultado({ item: propio({ id: 'MLUC', relaciones: ['MLUT'] }), ptw: { ok: false, error: 'http_500' } });
  const trad = resultado({ item: propio({ id: 'MLUT', catalogo: false, producto_catalogo: null }), pid: null });
  const res = new Map([['MLUC', cat], ['MLUT', trad]]);
  assert.equal(agruparPorFicha(oportunidades(res), res).length, 0);
  const d = gemelasDesincronizadas([propio({ id: 'MLUC', relaciones: ['MLUT'] }), propio({ id: 'MLUT', catalogo: false, precio: 1100, relaciones: ['MLUC'] })]);
  assert.equal(d.length, 1); assert.equal(d[0].tipo, 'gemela_precio_distinto');
});
