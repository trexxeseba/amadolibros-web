import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertasCatalogo, oportunidades } from '../src/analisis.mjs';
import { clasificar } from '../src/competencia.mjs';
import { manufacturingDays, configIssues } from '../src/publicaciones.mjs';

const propio = (over = {}) => ({ id: 'MLU1', titulo: 'Libro', enlace: 'https://x', isbn: '9789501203998', precio: 1000, moneda: 'UYU', estado: 'active', disponible: 3, condicion: 'new', catalogo: true, producto_catalogo: 'MLU19864611', plazo_dias: 0, relaciones: [], ...over });
const oferta = (over = {}) => ({ item_id: 'MLU9', vendedor: '1', precio: 800, moneda: 'UYU', condicion: 'new', internacional: false, plazo_dias: 20, plazo_fuente: 'items/bulk', estado: 'active', disponible: 2, enlace: 'https://y', ...over });
const resultado = (over = {}) => ({ item: propio(), pid: 'MLU19864611', consulta: { fecha: '2026-11-03T12:00:00.000Z', completa: true, error: null }, ofertas: [], comparables: [], excluidas: 0, estado: 'sin_competidores', ptw: null, ...over });

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
  assert.match(decidir[0].texto, /no está comprobado que entregue de inmediato/);
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

test('oportunidad con importe sólo cuando el competidor a pedido más barato está por encima', () => {
  const caro = oferta({ precio: 1300 }), barato = oferta({ item_id: 'MLU8', precio: 900 });
  const r1 = resultado({ ofertas: [caro], comparables: [caro], estado: 'solo_con_plazo', ptw: { ok: true, data: { status: 'winning', winner: { item_id: 'MLU1' } } } });
  const [op] = oportunidades(new Map([['MLU1', r1]]), { techos: { MLU1: 1200 } });
  assert.equal(op.sugerido, 1200); // acotado por el techo
  const r2 = resultado({ ofertas: [barato], comparables: [barato], estado: 'solo_con_plazo' });
  const [op2] = oportunidades(new Map([['MLU1', r2]]));
  assert.equal(op2.sugerido, null); assert.equal(op2.revisar, true);
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
  // Verificada pausada o sin stock: no compite.
  assert.equal(clasificar([oferta({ estado: 'paused', disponible: 0 })], propio()).estado, 'sin_competidores');
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
