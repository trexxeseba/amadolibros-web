import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cantidadSugerida, opportunitiesFromBi, upsertOpportunities, listOpportunities, setOpportunityState, opportunitySummary, pendingToNotify, markNotified, refreshOpportunities, catalogMeta } from '../../worker-sync/oportunidades.js';
import { ownStockIndex } from '../../worker-sync/reposicion-facts.js';
import { buildDigestEmail } from '../../worker-sync/daily-panel-digest.js';
import { createOportunidadesPanel, renderOportunidades } from '../panel/oportunidades.js';
import { createSessionToken, deriveSessionSecret, sessionCookieHeader } from '../_shared/panel-auth.js';

function database(t) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const statement = (sql, args = []) => ({ sql, args, bind(...values) { return statement(sql, values); }, async first() { return sqlite.prepare(sql).get(...args) ?? null; }, async all() { return { results: sqlite.prepare(sql).all(...args) }; }, async run() { return { meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }; } });
  return { prepare: sql => statement(sql), async batch(items) { sqlite.exec('BEGIN'); try { const r = items.map(s => ({ results: sqlite.prepare(s.sql).all(...s.args) })); sqlite.exec('COMMIT'); return r; } catch (e) { sqlite.exec('ROLLBACK'); throw e; } }, sqlite };
}

const NOW = Date.parse('2026-10-27T12:00:00Z'), DAY = 864e5;
const A = '9780306406157', B = '9788420412146', C = '9781418599942';

test('cantidad = objetivo − stock físico − en camino; 2 o 3 sólo con repetición real y costo; una señal aislada vale una prueba de 1', () => {
  // Vende 6 cada 90 días (2 por mes): objetivo 3 con repetición y costo.
  assert.deepEqual(cantidadSugerida({ u90: 6, u365: 20, stock: 0, en_transito: 0, costo_conocido: true }), { objetivo: 3, cantidad: 3, nivel: 'firme', motivo: null, faltantes: [] });
  // Con 1 en stock y 1 en camino, sólo falta 1.
  assert.equal(cantidadSugerida({ u90: 6, u365: 20, stock: 1, en_transito: 1, costo_conocido: true }).cantidad, 1);
  // Ya cubierto: nunca negativo.
  assert.equal(cantidadSugerida({ u90: 6, u365: 20, stock: 2, en_transito: 2, costo_conocido: true }).cantidad, 0);
  // Sin costo cargado no se pasa de 1: provisional, con el motivo.
  const sinCosto = cantidadSugerida({ u90: 6, u365: 20, stock: 0, costo_conocido: false });
  assert.equal(sinCosto.cantidad, 1); assert.equal(sinCosto.nivel, 'provisional'); assert.match(sinCosto.motivo, /bloqueado hasta completar costo/);
  // Sin repetición (una venta en el año) no hay 2 ni 3.
  const unaVenta = cantidadSugerida({ u90: 1, u365: 1, costo_conocido: true });
  assert.equal(unaVenta.cantidad, 1); assert.equal(unaVenta.nivel, 'firme');
  const dosEnTresMeses = cantidadSugerida({ u90: 4, u365: 2, costo_conocido: true });
  assert.equal(dosEnTresMeses.cantidad, 1); assert.equal(dosEnTresMeses.nivel, 'provisional');
  // Señal externa aislada en un ISBN sin ventas propias: prueba de 1, nunca 3.
  const externa = cantidadSugerida({ u90: 0, u365: 0, senal_externa: true, costo_conocido: true });
  assert.equal(externa.cantidad, 1); assert.equal(externa.nivel, 'provisional'); assert.match(externa.motivo, /una sola señal externa/);
  // Sin ninguna señal: bloqueado, 0.
  assert.equal(cantidadSugerida({}).nivel, 'bloqueado');
  // Ventana de ventas incompleta también frena el 2/3.
  assert.equal(cantidadSugerida({ u90: 6, u365: 20, costo_conocido: true, ventana_completa: false }).cantidad, 1);
});

test('stock compartido: dos publicaciones del mismo ejemplar no suman (máximo, no suma)', () => {
  const idx = ownStockIndex({ items: [
    { id: 'MLU1', isbn: A, status: 'active', available_quantity: 1, catalog_listing: false },
    { id: 'MLU2', isbn: A, status: 'active', available_quantity: 1, catalog_listing: true },
  ] });
  assert.equal(idx.get(A).stock_propio, 1);
  // Con ese stock, un objetivo de 2 pide 1, no 0 (que saldría de sumar 1+1).
  assert.equal(cantidadSugerida({ u90: 3, u365: 6, stock: idx.get(A).stock_propio, costo_conocido: true }).cantidad, 1);
});

const facts = new Map([[A, { foto: '2026-10-27', foto_edad_horas: 3, captura_posterior: null, competidores_comparables: 2, competidores_a_pedido: 0, precio_minimo: 1500 }],
  [B, { foto: '2026-10-27', foto_edad_horas: 3, captura_posterior: null, competidores_comparables: 0, competidores_a_pedido: 2, precio_minimo_a_pedido: 2000 }],
  [C, { foto: '2026-10-27', foto_edad_horas: 3, captura_posterior: null, competidores_comparables: 0, competidores_a_pedido: 1, precio_minimo_a_pedido: 900 }]]);
const bi = () => ({
  competencia: { ok: true, data: { facts } },
  abc: { ok: true, data: { sorted: [{ isbn: A, title: 'Libro A', u90: 6, u365: 20, stock: 0, clase: 'A', avgPrice: 1400 }, { isbn: B, title: 'Libro B', u90: 2, u365: 4, stock: 0, clase: 'B', avgPrice: 1800 }, { isbn: C, title: 'Libro C', u90: 3, u365: 5, stock: 2, clase: 'B', avgPrice: 800 }] } },
  precios: { ok: true, data: { lista: [{ isbn: C, title: 'Libro C', actual: 800, min: 1200, competidores: 3, sugerido: 1170, subaPct: 46, ganaMes: 370, u90: 3, stock: 2, agotado: false, margenActual: { margin: 200 }, margenSugerido: { margin: 500 } }], solos: [] } },
  inventario: { ok: true, data: { aSinStock: [{ isbn: A, title: 'Libro A', u90: 6, u365: 20, stock: 0, mercado: { estado: 'sostenible', nacionales: 2, min: 1500, margenAlMin: 400, texto: '2 lo tienen con entrega inmediata; al precio del más barato ganás $ 400 por libro: conviene reponer.' }, compra: { supplier: 'CELESA', d: NOW - 40 * DAY }, costo: 900, margen: { margin: 500 } }] } },
});

test('oportunidades desde Brújula: subir precio, reponer con cantidad y tener inmediato, con evidencia y enlaces', () => {
  const meta = catalogMeta({ items: [{ id: 'MLU9', isbn: C, status: 'active', thumbnail: 'https://http2.mlstatic.com/x.jpg', permalink: 'https://articulo.mercadolibre.com.uy/MLU-9' }] });
  const list = opportunitiesFromBi(bi(), { meta, nowMs: NOW, facts: new Map([[A, { compras: { en_transito_estimado: 1 }, ventas: { ventana_365d_completa: true } }]]) });
  const byId = Object.fromEntries(list.map(o => [o.id, o]));
  const subir = byId[`subir_precio:${C}`];
  assert.equal(subir.accion, 'Subir de $ 800 a $ 1.170 (+46%)');
  assert.equal(subir.impacto_mes, 370); assert.equal(subir.confianza, 'alta');
  assert.deepEqual(subir.enlaces, { panel: `/panel/reposicion?q=${C}`, ml: 'https://articulo.mercadolibre.com.uy/MLU-9', tapa: 'https://http2.mlstatic.com/x.jpg' });
  assert.match(subir.evidencia.texto, /Lo tenés a \$ 800 y el más barato con entrega inmediata está a \$ 1\.200/);
  const reponer = byId[`reponer:${A}`];
  assert.equal(reponer.cantidad, 2, 'objetivo 3 − 0 stock − 1 en camino');
  assert.equal(reponer.cantidad_nivel, 'firme');
  assert.equal(reponer.impacto_mes, 800, '2 por mes × $ 400 al precio del más barato');
  assert.equal(reponer.confianza, 'alta');
  assert.match(reponer.evidencia.texto, /Hay 1 en camino: se descuenta/);
  assert.match(reponer.evidencia.texto, /Última compra: CELESA/);
  const inmediato = byId[`tener_inmediato:${B}`];
  assert.equal(inmediato.cantidad, 1); assert.equal(inmediato.cantidad_nivel, 'provisional');
  assert.match(inmediato.evidencia.texto, /2 vendedores lo ofrecen a pedido desde \$ 2\.000 y nadie con entrega inmediata/);
  assert.ok(!byId[`tener_inmediato:${A}`], 'un A sin stock sale como reponer, no dos veces');
  assert.ok(!byId[`tener_inmediato:${C}`], 'con stock no hace falta');
  // Nunca "nadie lo vende": siempre con la fuente.
  for (const o of list) assert.doesNotMatch(o.evidencia.texto, /nadie lo vende|nadie más lo tiene/i);
});

test('bandeja: recalcular no duplica ni pisa el estado; el correo avisa una vez y las pendientes siguen', async t => {
  const db = database(t);
  const list = opportunitiesFromBi(bi(), { nowMs: NOW });
  let r = await upsertOpportunities(db, list, NOW);
  assert.deepEqual([r.total, r.nuevas, r.actualizadas], [3, 3, 0]);
  assert.ok(await setOpportunityState(db, `subir_precio:${C}`, 'aprobado', { nota: 'subido en ML', nowMs: NOW + 1000 }));
  assert.equal(await setOpportunityState(db, 'reponer:0000000000000', 'aprobado'), false);
  await assert.rejects(() => setOpportunityState(db, `reponer:${A}`, 'otra'), /invalid_state/);
  // Al día siguiente se recalcula con otra evidencia: misma fila, estado intacto.
  const bi2 = bi(); bi2.precios.data.lista[0].sugerido = 1180;
  r = await upsertOpportunities(db, opportunitiesFromBi(bi2, { nowMs: NOW + DAY }), NOW + DAY);
  assert.deepEqual([r.nuevas, r.actualizadas], [0, 3]);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM comp_opportunities').get().n, 3);
  const aprob = (await listOpportunities(db, { estado: 'aprobado', nowMs: NOW + DAY }))[0];
  assert.equal(aprob.id, `subir_precio:${C}`); assert.equal(aprob.nota, 'subido en ML'); assert.equal(aprob.evidencia.sugerido, 1180); assert.equal(aprob.vigente, true);
  // Pendientes ordenadas por impacto sustentado; la de impacto desconocido va última.
  const pend = await listOpportunities(db, { estado: 'pendiente', nowMs: NOW + DAY });
  assert.deepEqual(pend.map(o => o.id), [`reponer:${A}`, `tener_inmediato:${B}`]);
  // Correo: avisa las nuevas una vez; mañana no las repite pero siguen pendientes.
  let nuevas = await pendingToNotify(db, { nowMs: NOW + DAY });
  assert.equal(nuevas.length, 2);
  await markNotified(db, nuevas.map(o => o.id), NOW + DAY);
  nuevas = await pendingToNotify(db, { nowMs: NOW + 2 * DAY });
  assert.equal(nuevas.length, 0);
  const sum = await opportunitySummary(db, NOW + 2 * DAY);
  assert.equal(sum.pendientes_vigentes, 2); assert.equal(sum.sin_avisar, 0); assert.equal(sum.por_estado.aprobado.total, 1);
  // Si deja de observarse 4 días, ya no es vigente pero no se pierde.
  const viejas = await listOpportunities(db, { estado: 'pendiente', nowMs: NOW + 6 * DAY });
  assert.equal(viejas.length, 2); assert.equal(viejas[0].vigente, false);
  assert.equal((await opportunitySummary(db, NOW + 6 * DAY)).pendientes_vigentes, 0);
  // refreshOpportunities no lanza aunque falten hechos.
  const rr = await refreshOpportunities(db, { bi: bi(), catalog: null, factsFor: async () => { throw new Error('x'); }, nowMs: NOW + 7 * DAY });
  assert.equal(rr.state, 'ok'); assert.equal(rr.con_hechos, 0);
  assert.equal((await opportunitySummary(db, NOW + 7 * DAY)).pendientes_vigentes, 2);
});

test('el correo diario lleva la bandeja: cuántas pendientes y las nuevas con su acción', () => {
  const bandeja = { resumen: { pendientes_vigentes: 2, sin_avisar: 1 }, nuevas: [{ id: `reponer:${A}`, isbn: A, titulo: 'Libro <A>', tipo: 'reponer', accion: 'Reponer 2', impacto_mes: 800, confianza: 'alta' }] };
  const { text, html } = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, bandeja });
  assert.match(text, /BANDEJA DE OPORTUNIDADES — 2 pendientes de decidir/);
  assert.match(text, /- Libro <A> · Reponer: Reponer 2 \(unos \$ 800 más por mes\) · confianza alta/);
  assert.match(text, /panel\/oportunidades/);
  assert.match(html, /Libro &lt;A&gt;/);
  assert.doesNotMatch(buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0 }).text, /BANDEJA/);
});

test('panel de oportunidades: exige sesión, lista por estado y guarda el estado con nota', async t => {
  const db = database(t);
  await upsertOpportunities(db, opportunitiesFromBi(bi(), { nowMs: NOW }), NOW);
  const env = { APP_ENV: 'production', PANEL_PASSWORD: 'una-clave-larga', ORDERS_DB: db };
  const handler = createOportunidadesPanel({ now: () => NOW + 3600000 });
  assert.equal((await handler({ request: new Request('https://www.amadolibros.com/panel/oportunidades'), env })).status, 303);
  const cookie = sessionCookieHeader(await createSessionToken(await deriveSessionSecret(env.PANEL_PASSWORD))).split(';')[0];
  const res = await handler({ request: new Request('https://www.amadolibros.com/panel/oportunidades', { headers: { cookie } }), env });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Reponer 2|Reponer 3/);
  assert.match(html, /Subir de \$ 800 a \$ 1\.170/);
  assert.match(html, /confianza alta/i);
  assert.match(html, /Pendiente \(3\)/);
  assert.match(res.headers.get('content-security-policy'), /img-src https:\/\/http2\.mlstatic\.com/);
  // Cambio de estado por formulario, mismo origen.
  const body = new URLSearchParams({ id: `reponer:${A}`, estado: 'pedido', nota: 'pedido a Celesa' });
  const post = await handler({ request: new Request('https://www.amadolibros.com/panel/oportunidades?estado=pendiente', { method: 'POST', headers: { cookie, origin: 'https://www.amadolibros.com', 'content-type': 'application/x-www-form-urlencoded' }, body }), env });
  assert.equal(post.status, 303);
  assert.match(post.headers.get('location'), /estado=pendiente&hecho=1/);
  assert.equal(db.sqlite.prepare('SELECT estado,nota FROM comp_opportunities WHERE id=?').get(`reponer:${A}`).estado, 'pedido');
  // Origen ajeno o id raro: no toca nada.
  const bad = await handler({ request: new Request('https://www.amadolibros.com/panel/oportunidades', { method: 'POST', headers: { cookie, origin: 'https://otro.example', 'content-type': 'application/x-www-form-urlencoded' }, body }), env });
  assert.equal(bad.status, 403);
  const bad2 = await handler({ request: new Request('https://www.amadolibros.com/panel/oportunidades', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ id: 'x;DROP', estado: 'pedido' }) }), env });
  assert.equal(bad2.status, 400);
  const pedidos = await (await handler({ request: new Request('https://www.amadolibros.com/panel/oportunidades?estado=pedido', { headers: { cookie } }), env })).text();
  assert.match(pedidos, /pedido a Celesa/);
  // Render sin filas.
  assert.match(renderOportunidades({ resumen: { por_estado: {}, pendientes_vigentes: 0, sin_avisar: 0 }, lista: [], estado: 'pendiente' }), /No hay oportunidades/);
});
