import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDigestEmail, montevideoDay, sendDailyPanelDigest } from '../daily-panel-digest.js';

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
  assert.match(text, /Ventas cobradas: 2 \(\$ 4\.000\)/);
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
