import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestEmail, clasificarReposicion, montevideoDay, sendDailyPanelDigest } from '../daily-panel-digest.js';

const NOW = new Date('2026-10-08T11:03:00.000Z'); // 08:03 en Montevideo

const ship = [{ public_code: 'AL-1', buyer_name: 'Ana Pérez', delivery_type: 'shipping', payable_total_uyu: 2160 }];
const unpaid = [{ public_code: 'AL-2', buyer_name: '<b>Beto</b> Gómez', delivery_type: 'pickup', payment_provider: 'bank_transfer', payable_total_uyu: 2050 }];

test('el día de Montevideo se calcula con UTC-3 y ayer abarca 24 horas', () => {
  const y = montevideoDay(NOW, 1);
  assert.equal(y.date, '2026-10-07');
  assert.equal(y.startIso, '2026-10-07T03:00:00.000Z');
  assert.equal(y.endIso, '2026-10-08T03:00:00.000Z');
  // A las 00:30 de Montevideo el «hoy» sigue siendo el mismo día local.
  assert.equal(montevideoDay(new Date('2026-10-08T03:30:00.000Z')).date, '2026-10-08');
});

test('el correo cuenta qué hay para hacer y no lleva teléfonos ni direcciones', () => {
  const { subject, text, html } = buildDigestEmail({ toShip: ship, unpaid, soldCount: 2, soldTotal: 4000, createdCount: 3 });
  assert.equal(subject, 'Amado Libros — hoy: 1 para despachar y 1 sin pagar');
  assert.match(text, /PARA DESPACHAR \(1\)/);
  assert.match(text, /AL-1 · Ana · \$ 2\.160 · envío — https:\/\/www\.amadolibros\.com\/panel\/pedido\/AL-1/);
  assert.match(text, /SIN PAGAR — escribile al cliente \(1\)/);
  assert.match(text, /Ventas cobradas en la web: 2 \(\$ 4\.000\)/);
  assert.match(html, /Abrir el panel/);
  // El nombre lo escribe el comprador: nunca se inserta como HTML.
  assert.doesNotMatch(html, /<b>Beto/);
  assert.doesNotMatch(text + html, /buyer_phone|buyer_email|address/);
});

test('sin pendientes lo dice con buen tono', () => {
  const { subject, text } = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0 });
  assert.equal(subject, 'Amado Libros — hoy no hay nada pendiente');
  assert.match(text, /¡Todo despachado!/);
  assert.match(text, /Todos los pedidos están pagos/);
});

function dbMock() {
  return {
    prepare(sql) {
      return { bind() { return { async all() {
        if (sql.includes("payment_status = 'approved' AND fulfilled_at IS NULL")) return { results: ship };
        if (sql.includes("status = 'open'")) return { results: unpaid };
        if (sql.includes('SUM(')) return { results: [{ n: 1, total: 2160 }] };
        return { results: [{ n: 2 }] };
      } }; } };
    },
  };
}
function kvMock() { const m = new Map(); return { m, async get(k) { return m.get(k) || null; }, async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); } }; }
const ENV = () => ({ RESEND_API_KEY: 're_x', SALES_NOTIFICATION_FROM: 'Amado <web@x.com>', DAILY_DIGEST_TO: 'a@x.com, b@x.com', ORDERS_DB: dbMock(), AMADO_KV: kvMock() });

test('manda un solo correo por día a las dos personas', async () => {
  const env = ENV();
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 200 }; };
  assert.equal((await sendDailyPanelDigest(env, { now: NOW, fetchFn })).status, 'sent');
  assert.deepEqual(calls[0].body.to, ['a@x.com', 'b@x.com']);
  assert.equal(calls[0].headers['Idempotency-Key'], 'panel-digest/2026-10-08');
  // El segundo disparo del día no repite.
  assert.deepEqual(await sendDailyPanelDigest(env, { now: new Date('2026-10-08T12:03:00.000Z'), fetchFn }), { status: 'skipped', reason: 'already_sent' });
  assert.equal(calls.length, 1);
});

test('si Resend falla, libera la reserva para que el segundo disparo reintente', async () => {
  const env = ENV();
  const bad = async () => ({ ok: false, status: 500 });
  assert.equal((await sendDailyPanelDigest(env, { now: NOW, fetchFn: bad })).status, 'failed');
  const good = async () => ({ ok: true, status: 200 });
  assert.equal((await sendDailyPanelDigest(env, { now: new Date('2026-10-08T12:03:00.000Z'), fetchFn: good })).status, 'sent');
});

test('sin configuración no manda nada y no rompe', async () => {
  assert.deepEqual(await sendDailyPanelDigest({}, { now: NOW, fetchFn: async () => { throw new Error('no debe llamar'); } }), { status: 'skipped', reason: 'config' });
});

test('una prueba manual marca el asunto, no gasta la reserva del día y no la libera si falla', async () => {
  const env = ENV();
  const subjects = [];
  const fetchFn = async (url, init) => { subjects.push(JSON.parse(init.body).subject); return { ok: true, status: 200 }; };
  assert.equal((await sendDailyPanelDigest(env, { now: NOW, fetchFn, test: true })).status, 'sent');
  assert.match(subjects[0], /^\[PRUEBA\] Amado Libros — hoy:/);
  assert.equal(env.AMADO_KV.m.size, 0);
  // El correo real de la mañana sale igual.
  assert.equal((await sendDailyPanelDigest(env, { now: NOW, fetchFn })).status, 'sent');
  assert.doesNotMatch(subjects[1], /PRUEBA/);
});

test('el correo lista los WhatsApp que dejaron los clientes', () => {
  const { subject, text, html } = buildDigestEmail({
    toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0,
    whatsapps: [{ whatsapp: '59899123456', product_title: 'Libro raro' }],
  });
  assert.match(subject, /1 cliente dejó su WhatsApp/);
  assert.match(text, /https:\/\/wa\.me\/59899123456/);
  assert.match(html, /Libro raro/);
});

test('sección Brújula: qué reponer, subir precio, se agota y a pérdida, con enlace a cada libro', () => {
  const brujula = {
    reponer: [{ isbn: '9781644732168', title: 'Biblia RVR', detalle: 'vendiste 6 en 90 días; al precio del más barato ganás $ 1.100 por libro' }],
    subir: [{ isbn: '9780000000001', title: 'Tarot X', detalle: 'de $ 900 a $ 1.170 (+30%)' }],
    agotan: [],
    perdida: [{ isbn: '9780000000002', title: 'ECG <Handbook>', detalle: 'lo vendés a $ 1.809 y reponerlo cuesta $ 2.196' }],
    pedidos: [{ isbn: '9780000000003', title: 'Ya pedido X', detalle: 'YA PEDIDO: compraste 4 u. el 10/11/26 (Celesa), hace 8 días; puede estar en camino.' }],
    ultimo: [{ isbn: '9781365910753', title: 'Relato del psicoanálisis de un niño', detalle: 'Queda 1, alcanza unos 61 días. Vendiste 1 en 90 y 6 en 12 meses a $ 1.700. Pedí 1.' }],
    ultimoTotal: 9,
  };
  const { text, html } = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, brujula });
  assert.match(text, /BRÚJULA AMADO — qué hacer hoy/);
  assert.match(text, /Conviene reponer:\n  - Biblia RVR: vendiste 6/);
  assert.match(text, /Subile el precio/);
  assert.doesNotMatch(text, /Se agotan pronto/, 'un bloque vacío no aparece');
  assert.match(text, /Ya pedidos: esperando que lleguen:\n  - Ya pedido X: YA PEDIDO: compraste 4 u\./);
  assert.match(text, /Último ejemplar de un libro que se vende: pedilo \(1 de 9; todos en el panel\):\n  - Relato del psicoanálisis de un niño: Queda 1, alcanza unos 61 días\./);
  assert.match(html, /reposicion\?q=9781365910753/);
  assert.match(html, /Brújula Amado: qué hacer hoy/);
  assert.match(html, /reposicion\?q=9781644732168/);
  assert.match(html, /ECG &lt;Handbook&gt;/);
  const sin = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, brujula: null });
  assert.doesNotMatch(sin.text, /BRÚJULA/);
});

test('"Subile el precio" dice cuántos libros con stock están muy por debajo del mercado cuando hay más que los listados', () => {
  const fila = { isbn: '9788441437623', title: 'Cola larga', detalle: 'de $ 1.395 a $ 1.850 (+33%)' };
  const base = { toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0 };
  const conMas = buildDigestEmail({ ...base, brujula: { reponer: [], subir: [fila], agotan: [], perdida: [], subirTotal: 212 } });
  assert.match(conMas.text, /Subile el precio \(1 de 212 con stock muy por debajo del mercado; todos en el panel\):/);
  assert.match(conMas.html, /Subile el precio \(1 de 212 con stock muy por debajo del mercado; todos en el panel\)/);
  const justos = buildDigestEmail({ ...base, brujula: { reponer: [], subir: [fila], agotan: [], perdida: [], subirTotal: 1 } });
  assert.match(justos.text, /  Subile el precio:\n/);
  // Un resumen armado sin el total (versión anterior) se muestra como siempre.
  const sinTotal = buildDigestEmail({ ...base, brujula: { reponer: [], subir: [fila], agotan: [], perdida: [] } });
  assert.match(sinTotal.text, /  Subile el precio:\n/);
});

test('sección Brújula: "Volvieron a tener stock" y "Competidores que se quedaron sin stock" salen aunque no haya nada más', () => {
  const brujula = {
    reponer: [], pedidos: [], subir: [], agotan: [], perdida: [], ultimo: [], ultimoTotal: 0, subirTotal: 0,
    repuestos: [{ isbn: '9789505181391', title: 'La fundación de lo inconciente', detalle: 'Ahora hay 2 ejemplares: alcanzan para unos 122 días de venta al ritmo de los últimos 12 meses (1 cada 61 días, 6 vendidos).' }],
    competidores: [{ isbn: '9781365910753', title: 'Relato <del> psicoanálisis', detalle: 'Pocho dejó de ofrecer este libro en el catálogo. Vos tenés 1: te quedás con esa demanda, no lo dejes agotar.' }],
  };
  const { text, html } = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, brujula });
  assert.match(text, /Volvieron a tener stock:\n  - La fundación de lo inconciente: Ahora hay 2 ejemplares/);
  assert.match(text, /Competidores que se quedaron sin stock: tu oportunidad:\n  - Relato <del> psicoanálisis: Pocho dejó de ofrecer/);
  assert.match(html, /Volvieron a tener stock/);
  assert.match(html, /Relato &lt;del&gt; psicoanálisis/, 'el título va escapado');
  assert.doesNotMatch(text, /Conviene reponer|Ya pedidos/, 'los bloques vacíos no aparecen');
});

const datos = extra => ({ stock: 0, cobertura: null, ultimaVenta: '22/11/26', hace: 1, u30: 2, u90: 8, u365: 19, ritmo: 19, meses: [3, 2, 0, 2, 4, 2],
  precio: 2638, pedir: 3, costo: 1097, proveedor: 'Celesa', compra: 'Última compra: 2 u. el 08/09/26 (Celesa), hace 75 días', mercado: 'Nadie más lo tiene con entrega inmediata en Uruguay',
  pedido: 'no', competencia: 'no', competidorMin: null, pocoVendido: false, sinIdentidad: false, ...extra });
const BRUJULA = {
  reponer: [
    { isbn: '1', title: 'Verificado', detalle: 'x', datos: datos() },
    { isbn: '2', title: 'Con competencia', detalle: 'x', datos: datos({ competencia: 'si', competidorMin: 750 }) },
    { isbn: '3', title: 'Sin compras cargadas', detalle: 'x', datos: datos({ pedido: 'sin_verificar', compra: 'Sin compras registradas' }) },
  ],
  ultimo: [{ isbn: '4', title: 'Sin dato de mercado', detalle: 'x', datos: datos({ stock: 1, cobertura: 17, competencia: 'sin_dato' }) }],
  hoy: [{ isbn: '5', title: 'Una sola venta', detalle: 'x', datos: datos({ u365: 1, pocoVendido: true }) }, { isbn: '1', title: 'Verificado', detalle: 'x', datos: datos() }],
  pedidos: [{ isbn: '6', title: 'En camino', detalle: 'x', datos: datos({ pedido: 'si' }) }],
  subir: [], agotan: [], perdida: [], faltan: ['Casassa y Lorenzo', 'Amazon.com'], ultimoTotal: 28,
};

test('antes de decir "pedí": sólo va a "Para pedir hoy" lo que no está pedido y no tiene competencia con entrega inmediata', () => {
  const g = clasificarReposicion(BRUJULA);
  assert.deepEqual(g.pedir.map(r => r.title), ['Verificado'], 'una sola vez aunque esté en dos bloques');
  assert.deepEqual(g.noReponer.map(r => r.title), ['Con competencia']);
  assert.match(g.noReponer[0].motivo, /desde \$ 750/);
  assert.deepEqual(g.revisar.map(r => r.title), ['Sin compras cargadas', 'Sin dato de mercado', 'Una sola venta']);
  assert.match(g.revisar[0].motivo, /confirmá que no esté pedido/);
  assert.match(g.revisar[1].motivo, /sin dato de competencia/);
  assert.deepEqual(g.enCamino.map(r => r.title), ['En camino']);
});

test('el correo agrupa la reposición por chequeo y avisa una sola vez qué compras faltan cargar', () => {
  const { text, html } = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, brujula: BRUJULA });
  assert.match(text, /RESUMEN: Para pedir hoy: 1 · Revisar antes: 3 · No reponer: 1/);
  assert.match(html, /Para pedir hoy: sin pedido y sin competencia con entrega inmediata \(1\)/);
  assert.match(html, /No reponer por ahora: hay competencia con entrega inmediata \(1\)/);
  assert.equal(html.split('Faltan cargar las compras de Casassa y Lorenzo, Amazon.com').length - 1, 1);
  assert.match(html, /última venta el 22\/11\/26 \(ayer\)/);
  assert.match(text, /En el panel están todos: 28 con último ejemplar/);
});

test('"Ayer" suma las ventas de Mercado Libre y la competencia sale con el título del libro', () => {
  const base = { toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, ml: { count: 4, total: 9800 },
    competition: { eventos: [{ isbn: '9788415292739', title: 'El libro tibetano', texto: 'Perdiste el primer lugar del catálogo: para ganar, $ 1.068.' }] } };
  const { text, html } = buildDigestEmail(base);
  assert.match(text, /Ventas en Mercado Libre: 4 \(\$ 9\.800\)/);
  assert.match(text, /- El libro tibetano \(9788415292739\): Perdiste el primer lugar/);
  assert.match(html, /El libro tibetano/);
});

test('con DAILY_BRUJULA_TO salen dos correos: el del equipo sin Brújula ni montos, y el completo al dueño', async () => {
  const env = { ...ENV(), DAILY_DIGEST_TO: 'equipo@x.com', DAILY_BRUJULA_TO: 'dueno@x.com' };
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ body: JSON.parse(init.body), headers: init.headers }); return { ok: true, status: 200 }; };
  const r = await sendDailyPanelDigest(env, { now: NOW, fetchFn });
  assert.equal(r.status, 'sent');
  assert.equal(r.correos, 2);
  assert.deepEqual(calls.map(c => c.body.to), [['equipo@x.com'], ['dueno@x.com']]);
  assert.match(calls[1].body.subject, /^Brújula Amado —/);
  assert.equal(calls[1].headers['Idempotency-Key'], 'panel-brujula/2026-10-08');
  const equipo = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, brujula: BRUJULA, ml: { count: 4, total: 9800 } }, { equipo: true });
  assert.doesNotMatch(equipo.text + equipo.html, /Brújula|BRÚJULA|9\.800|Costo/);
  assert.match(equipo.text, /Ventas en Mercado Libre: 4\n/);
});

test('"Estás perdiendo estas ventas": lista los libros con stock donde tu precio es superior, sólo en el correo del dueño', () => {
  const pierde = { total: 37, lista: [{ isbn: '9788408259442', title: 'Libro <caro>', tuPrecio: 2300, minPrecio: 1754, pct: 31, vendedor: 'EL-YELMO-LIBROS', stock: 2 }] };
  const base = { toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, pierde };
  const { text, html } = buildDigestEmail(base);
  assert.match(text, /RESUMEN: Perdés por precio: 37/);
  assert.match(text, /SEBA, ESTÁS PERDIENDO ESTAS VENTAS: TU PRECIO ES SUPERIOR \(1 DE 37; TODOS EN EL PANEL\)/);
  assert.match(text, /- Libro <caro>: Tu precio \$ 2\.300 · EL-YELMO-LIBROS lo tiene con entrega inmediata a \$ 1\.754 · estás 31% arriba · para igualarlo bajá \$ 546 · tenés 2 en stock/);
  assert.match(html, /Seba, estás perdiendo estas ventas: tu precio es superior/);
  assert.match(html, /Libro &lt;caro&gt;/);
  const equipo = buildDigestEmail(base, { equipo: true });
  assert.doesNotMatch(equipo.text + equipo.html, /perdiendo|2\.300/i);
});

test('un competidor más caro que tu precio va a "Revisar", no a "No reponer"; y los ya pedidos lo dicen', () => {
  const g = clasificarReposicion({ reponer: [{ isbn: '7', title: 'Competidor caro', detalle: 'x', datos: datos({ precio: 2482, competencia: 'si', competidorMin: 3142 }) }],
    pedidos: [{ isbn: '6', title: 'En camino', detalle: 'x', datos: datos({ pedido: 'si' }) }] });
  assert.deepEqual(g.noReponer, []);
  assert.match(g.revisar[0].motivo, /más caro \(\$ 3\.142 contra tu \$ 2\.482\)/);
  assert.equal(g.enCamino[0].motivo, 'Ya está pedido: no lo pidas de nuevo.');
  const { text, html } = buildDigestEmail({ toShip: [], unpaid: [], soldCount: 0, soldTotal: 0, createdCount: 0, brujula: BRUJULA });
  assert.doesNotMatch(text + html, /undefined/);
});
