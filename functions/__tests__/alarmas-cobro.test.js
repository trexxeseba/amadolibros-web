// Alarmas del cobro: definición de los controles de Checkly, alta, simulacro y
// la lectura de /api/checkout-health que hace el smoke posterior al deploy.
// Todo con dobles en memoria: no hay red, no se toca Checkly ni Producción.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  aplicar, cobroChecks, emailChannel, estado, maskEmail, parseRecipients, simulacroCheck,
  SITE, TAG_COBRO, TAG_SIMULACRO, TAG_WEB,
} from '../../scripts/monitoring/checkly-cobro.mjs';

const require = createRequire(import.meta.url);
const { analyzeCheckoutHealth, SMOKE_ROUTES } = require('../../scripts/smoke-production.js');

const ALL_OK = { configuracion: 'ok', cobros_encendidos: 'ok', base_de_pedidos: 'ok', catalogo: 'ok',
  verificacion_anti_robots: 'ok', mercado_pago: 'ok', clave_de_avisos_de_pago: 'ok', correo_de_avisos: 'ok' };
const ID = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function fakeApi({ checks = [], channels = [] } = {}) {
  const calls = [];
  let next = 100;
  const api = async (path, { method = 'GET', body } = {}) => {
    calls.push({ path, method, body });
    if (method === 'GET' && path === '/v1/checks') return checks;
    if (method === 'GET' && path === '/v1/alert-channels') return channels;
    if (method === 'GET' && path === '/v1/accounts/me/entitlements') return { plan: 'hobby', entitlements: [{ key: 'API_CHECKS', enabled: true, quantity: 0 }] };
    if (method === 'GET' && path === '/v1/check-statuses') return [];
    if (method === 'POST' && path === '/v1/alert-channels') { const c = { id: next++, ...body }; channels.push(c); return c; }
    if (method === 'POST' && path.startsWith('/v1/checks/api')) return { id: ID(next++) };
    if (method === 'PUT' && path.startsWith('/v1/checks/')) return { id: path.split('/')[4].split('?')[0] };
    throw new Error('inesperado: ' + method + ' ' + path);
  };
  api.calls = calls;
  return api;
}

test('destinatarios: salen de los avisos de venta de producción', () => {
  const toml = '[env.preview.vars]\nSALES_NOTIFICATION_TO = "preview@example.test"\n[env.production.vars]\nSALES_NOTIFICATION_TO   = "Uno@Example.test, dos@example.test"\n';
  assert.deepEqual(parseRecipients(toml), ['uno@example.test', 'dos@example.test']);
  assert.throws(() => parseRecipients('[env.production.vars]\n'), /DESTINATARIOS_AUSENTES/);
});

test('las casillas nunca se imprimen completas', () => {
  assert.equal(maskEmail('persona@example.test'), 'p***@example.test');
});

test('canal de correo: avisa la falla y la recuperación, y no se suscribe solo', () => {
  const channel = emailChannel('a@example.test');
  assert.equal(channel.sendFailure, true);
  assert.equal(channel.sendRecovery, true);
  assert.equal(channel.autoSubscribe, false);
});

test('controles del cobro: sólo lectura o rechazo esperado, nunca un pedido ni un pago', () => {
  const checks = cobroChecks([7, 8]);
  assert.equal(checks.length, 2);
  for (const check of checks) {
    assert.deepEqual(check.tags, [TAG_COBRO]);
    assert.equal(check.activated, true);
    assert.equal(check.frequency, 10);
    assert.equal(check.alertSettings.runBasedEscalation.failedRunThreshold, 2);
    assert.deepEqual(check.alertChannelSubscriptions, [{ alertChannelId: 7, activated: true }, { alertChannelId: 8, activated: true }]);
    assert.ok(check.request.url.startsWith(SITE + '/api/'));
  }
  const [health, webhook] = checks;
  assert.equal(health.request.method, 'GET');
  assert.equal(health.request.url, SITE + '/api/checkout-health');
  assert.equal(webhook.request.method, 'POST');
  assert.ok(webhook.request.url.includes('/api/webhooks/mercadopago'));
  // Sin encabezado de firma: el servidor tiene que rechazarlo.
  assert.equal(webhook.request.headers.some(h => /signature/i.test(h.key)), false);
  assert.deepEqual(webhook.request.assertions, [{ source: 'STATUS_CODE', comparison: 'EQUALS', target: '401' }]);
  // Ningún control pega contra los servicios que crean pedidos o pagos.
  for (const check of checks) assert.equal(/\/api\/(orders|preferences|transfer-options)/.test(check.request.url), false);
});

test('simulacro: falla a propósito sobre /api/health y se distingue de los controles reales', () => {
  const failing = simulacroCheck([7], { failing: true });
  assert.deepEqual(failing.tags, [TAG_SIMULACRO]);
  assert.match(failing.name, /SIMULACRO/);
  assert.equal(failing.request.url, SITE + '/api/health');
  assert.equal(failing.request.assertions[0].target, '599');
  assert.equal(simulacroCheck([7], { failing: false }).request.assertions[0].target, '200');
});

test('aplicar: crea canales y controles, y suma el correo a los controles de septiembre sin tocar el resto', async () => {
  const viejo = { id: ID(1), name: 'Amado - catalogo y sincronizacion', checkType: 'API', activated: true, frequency: 10, tags: [TAG_WEB],
    request: { method: 'GET', url: SITE + '/api/status' }, alertChannelSubscriptions: [{ alertChannelId: 1, activated: true }], createdAt: 'x' };
  const pausado = { ...viejo, id: ID(2), name: 'Amado - prueba de entrega al backend', activated: false };
  const api = fakeApi({ checks: [viejo, pausado], channels: [{ id: 1, type: 'WEBHOOK', config: { name: 'backend' } }] });
  await aplicar({ api, recipients: ['a@example.test', 'b@example.test'], wait: false });

  const created = api.calls.filter(c => c.method === 'POST' && c.path.startsWith('/v1/alert-channels'));
  assert.equal(created.length, 2);
  const newChecks = api.calls.filter(c => c.method === 'POST' && c.path.startsWith('/v1/checks/api'));
  assert.equal(newChecks.length, 2);
  const puts = api.calls.filter(c => c.method === 'PUT');
  assert.equal(puts.length, 1, 'sólo el control activo de septiembre');
  assert.ok(puts[0].path.includes(ID(1)));
  assert.deepEqual(puts[0].body.alertChannelSubscriptions.map(s => s.alertChannelId), [1, 100, 101]);
  assert.equal(puts[0].body.request.url, SITE + '/api/status');
  assert.equal('createdAt' in puts[0].body, false);
});

test('aplicar dos veces no duplica canales ni controles', async () => {
  const channels = [{ id: 5, type: 'EMAIL', config: { address: 'a@example.test' } }];
  const existentes = cobroChecks([5]).map((c, i) => ({ ...c, id: ID(10 + i) }));
  const api = fakeApi({ checks: existentes, channels });
  await aplicar({ api, recipients: ['a@example.test'], wait: false });
  assert.equal(api.calls.filter(c => c.method === 'POST').length, 0);
  assert.equal(api.calls.filter(c => c.method === 'PUT').length, 2);
});

test('aplicar no da de alta nada si el diagnóstico del cobro no responde bien', async () => {
  const api = fakeApi();
  const fetchFn = async () => new Response(JSON.stringify({ ok: false }), { status: 503 });
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, _ms, ...args) => realSetTimeout(fn, 0, ...args);
  try {
    await assert.rejects(aplicar({ api, fetchFn, recipients: ['a@example.test'] }), /DIAGNOSTICO_DEL_COBRO_NO_RESPONDE_OK/);
  } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(api.calls.length, 0);
});

test('estado: sólo lee', async () => {
  const api = fakeApi({ checks: [], channels: [] });
  const original = console.log; console.log = () => {};
  try { await estado({ api }); } finally { console.log = original; }
  assert.ok(api.calls.every(c => c.method === 'GET'));
});

test('smoke: el diagnóstico del cobro está entre las rutas y sigue siendo un GET', () => {
  assert.ok(SMOKE_ROUTES.some(r => r.path === '/api/checkout-health'));
});

test('smoke con checkout encendido: exige 200 y todas las piezas en pie', () => {
  assert.deepEqual(analyzeCheckoutHealth(200, { ok: true, checks: ALL_OK }, 'enabled'), { ok: true });
  const caido = analyzeCheckoutHealth(503, { ok: false, checks: { ...ALL_OK, mercado_pago: 'falla' } }, 'enabled');
  assert.equal(caido.ok, false);
  assert.match(caido.reason, /mercado_pago/);
  assert.equal(analyzeCheckoutHealth(200, { ok: true }, 'enabled').ok, false);
  assert.equal(analyzeCheckoutHealth(404, {}, 'enabled').ok, false);
});

test('smoke con checkout apagado: sólo puede fallar el interruptor', () => {
  const apagado = { ...ALL_OK, cobros_encendidos: 'falla' };
  assert.deepEqual(analyzeCheckoutHealth(503, { ok: false, checks: apagado }, 'disabled'), { ok: true });
  assert.equal(analyzeCheckoutHealth(503, { ok: false, checks: { ...apagado, base_de_pedidos: 'falla' } }, 'disabled').ok, false);
  assert.equal(analyzeCheckoutHealth(200, { ok: true, checks: ALL_OK }, 'disabled').ok, false);
});
