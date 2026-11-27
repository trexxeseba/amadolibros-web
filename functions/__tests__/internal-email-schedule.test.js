import test from 'node:test';
import assert from 'node:assert/strict';
import { nextInternalEmailAt } from '../_shared/internal-email-schedule.js';
import { enviarAlarma } from '../../precio-ganador/src/alarma.mjs';
import { enviarMail } from '../../poda/src/mesa.mjs';
import { sendReportEmail } from '../../scripts/ops/send-report-email.mjs';

test('informes y alarmas esperan la próxima entrega de las 20:00 de Montevideo', () => {
  for (const [now, expected] of [
    ['2026-11-24T09:00:00-03:00', '2026-11-24T23:00:00.000Z'],
    ['2026-11-24T19:59:59-03:00', '2026-11-24T23:00:00.000Z'],
    ['2026-11-24T20:00:00-03:00', '2026-11-25T23:00:00.000Z'],
    ['2026-11-24T21:30:00-03:00', '2026-11-25T23:00:00.000Z'],
    ['2026-11-25T01:00:00Z', '2026-11-25T23:00:00.000Z'],
    ['2026-12-31T23:59:59Z', '2027-01-01T23:00:00.000Z'],
  ]) {
    const input = new Date(now);
    assert.equal(nextInternalEmailAt(input), expected);
    assert.equal(input.toISOString(), new Date(now).toISOString());
    assert.ok(new Date(expected) > input);
  }
  assert.throws(() => nextInternalEmailAt('fecha inválida'), TypeError);
});

test('alarma programa la entrega sin cambiar destinatario ni contenido', async t => {
  const before = { apiKey: process.env.RESEND_API_KEY, to: process.env.PRECIO_GANADOR_EMAIL_TO };
  process.env.RESEND_API_KEY = 'test-key';
  process.env.PRECIO_GANADOR_EMAIL_TO = 'equipo@example.test';
  t.after(() => {
    for (const [key, value] of Object.entries({ RESEND_API_KEY: before.apiKey, PRECIO_GANADOR_EMAIL_TO: before.to })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  let payload;
  // Desde el 26/11 la alarma sólo sale con ALARMAS_POR_MAIL=si y lleva encabezado APP/PROYECTO/COMETIDO.
  const result = await enviarAlarma({ asunto: 'Prueba', texto: 'Detalle',
    env: { RESEND_API_KEY: 'test-key', PRECIO_GANADOR_EMAIL_TO: 'equipo@example.test', ALARMAS_POR_MAIL: 'si' },
    fetcher: async (_url, opts) => { payload = JSON.parse(opts.body); return { ok: true }; } });
  assert.equal(result.status, 'enviado');
  assert.deepEqual(payload.to, ['equipo@example.test']);
  assert.equal(payload.subject, 'ALARMA Precio Ganador: Prueba');
  assert.match(payload.text, /^APP: /);
  assert.match(payload.text, /\nDetalle\n/);
  assert.match(payload.scheduled_at, /T23:00:00\.000Z$/);
  assert.ok(new Date(payload.scheduled_at).getTime() > Date.now());
});

test('rechazar la programación no causa un envío inmediato de respaldo', async () => {
  const calls = [];
  const result = await enviarMail({
    asunto: 'Poda', texto: 'Detalle',
    env: { RESEND_API_KEY: 'test-key', PODA_EMAIL_TO: 'equipo@example.test' },
    fetcher: async (_url, opts) => { calls.push(JSON.parse(opts.body)); return { ok: false, status: 422 }; },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].scheduled_at, /T23:00:00\.000Z$/);
});

test('el informe operativo programa el mismo contenido de texto y HTML', async () => {
  let payload;
  const result = await sendReportEmail({
    subject: 'Informe', markdown: '# Informe\n\nDetalle',
    config: { apiKey: 'test-key', from: 'equipo@example.test', to: ['equipo@example.test'] },
    fetchFn: async (_url, opts) => { payload = JSON.parse(opts.body); return { ok: true, json: async () => ({ id: 'test-mail' }) }; },
  });
  assert.equal(result.ok, true);
  assert.equal(payload.subject, 'Informe');
  assert.equal(payload.text, '# Informe\n\nDetalle');
  assert.match(payload.html, /Detalle/);
  assert.match(payload.scheduled_at, /T23:00:00\.000Z$/);
});
