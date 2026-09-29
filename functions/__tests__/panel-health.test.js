import test from 'node:test';
import assert from 'node:assert/strict';

import { deriveSyncWorkerState } from '../_shared/health-rules.js';
import { fechaCorta, healthSection, loadHealth } from '../_shared/panel-health.js';

const AHORA = new Date('2026-09-13T21:00:00.000Z');

function kvStub(valores = {}) {
  const puts = [];
  return {
    puts,
    async get(key) { return valores[key] ?? null; },
    async put(key, value, options) { puts.push({ key, value, options }); },
  };
}

function corridaOk(created_at = '2026-09-13T09:00:00.000Z') {
  return Response.json({
    workflow_runs: [{ conclusion: 'success', created_at, html_url: 'https://github.com/x/y/actions/runs/1' }],
  });
}

function fetchContador(respuesta = () => corridaOk()) {
  const llamadas = [];
  const fn = async (url) => { llamadas.push(String(url)); return respuesta(url); };
  fn.llamadas = llamadas;
  return fn;
}

// ── reglas ──────────────────────────────────────────────────────────────────

test('deriveSyncWorkerState replica in_progress y possibly_stuck de /api/status', () => {
  const reciente = deriveSyncWorkerState(
    { lastStarted: '2026-09-13T20:50:00.000Z', lastOk: '2026-09-13T07:20:00.000Z', lastError: '' },
    AHORA,
  );
  assert.equal(reciente.in_progress, true, 'empezó después del último ok: está corriendo');
  assert.equal(reciente.possibly_stuck, false, 'hace 10 minutos: todavía no está trabado');
  assert.equal(reciente.has_error, false);

  const trabado = deriveSyncWorkerState(
    { lastStarted: '2026-09-13T19:00:00.000Z', lastOk: '2026-09-13T07:20:00.000Z', lastError: 'x' },
    AHORA,
  );
  assert.equal(trabado.possibly_stuck, true, 'dos horas corriendo es trabado');
  assert.equal(trabado.has_error, true);

  const terminado = deriveSyncWorkerState(
    { lastStarted: '2026-09-13T07:15:00.000Z', lastOk: '2026-09-13T07:20:00.000Z' },
    AHORA,
  );
  assert.equal(terminado.in_progress, false);
});

// ── carga ───────────────────────────────────────────────────────────────────

test('sin KV el sync se declara no disponible y no se toca la red', async () => {
  const fetchFn = fetchContador();
  const salud = await loadHealth({ env: {} }, { now: AHORA, fetchFn });
  assert.equal(salud.sync.disponible, false);
  assert.equal(salud.reportes.disponible, false);
  assert.equal(fetchFn.llamadas.length, 0);
});

test('con KV el sync se evalúa con la misma regla que el correo diario', async () => {
  const kv = kvStub({ 'sync:last_ok': '2026-09-11T07:20:00.000Z' });
  const salud = await loadHealth({ env: { AMADO_KV: kv } }, { now: AHORA, fetchFn: fetchContador() });
  assert.equal(salud.sync.disponible, true);
  assert.equal(salud.sync.ok, false);
  assert.match(salud.problemas.join(' '), /61\.7 h/);
});

test('con PANEL_SALUD_REMOTO apagado no se consulta GitHub aunque haya KV', async () => {
  const fetchFn = fetchContador();
  const salud = await loadHealth(
    { env: { AMADO_KV: kvStub({ 'sync:last_ok': '2026-09-13T07:20:00.000Z' }) } },
    { now: AHORA, fetchFn },
  );
  assert.equal(salud.reportes.disponible, false);
  assert.match(salud.reportes.motivo, /PANEL_SALUD_REMOTO/);
  assert.equal(fetchFn.llamadas.length, 0);
});

test('encendido y sin caché consulta una vez por reporte y guarda el resultado', async () => {
  const kv = kvStub({ 'sync:last_ok': '2026-09-13T07:20:00.000Z' });
  const fetchFn = fetchContador();
  const salud = await loadHealth(
    { env: { AMADO_KV: kv, PANEL_SALUD_REMOTO: 'true' } },
    { now: AHORA, fetchFn },
  );
  assert.equal(salud.reportes.disponible, true);
  assert.equal(salud.reportes.desdeCache, false);
  assert.equal(fetchFn.llamadas.length, 7, 'una consulta por workflow vigilado');
  assert.ok(fetchFn.llamadas.every(u => u.includes('branch=main')), 'siempre la rama main');
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, 'panel:salud:workflows');
  assert.equal(kv.puts[0].options.expirationTtl, 600);
  // Lo que va a KV es chico: sólo los tres campos que se muestran.
  const guardado = JSON.parse(kv.puts[0].value);
  const primera = Object.values(guardado.corridas)[0].corrida;
  assert.deepEqual(Object.keys(primera).sort(), ['conclusion', 'created_at', 'html_url']);
});

test('con caché vigente no sale a la red y lo dice', async () => {
  const cache = JSON.stringify({
    consultadoEn: '2026-09-13T20:55:00.000Z',
    corridas: { 'deploy.yml': { ok: true, corrida: { conclusion: 'success', created_at: '2026-09-13T09:00:00.000Z', html_url: null } } },
  });
  const kv = kvStub({ 'sync:last_ok': '2026-09-13T07:20:00.000Z', 'panel:salud:workflows': cache });
  const fetchFn = fetchContador();
  const salud = await loadHealth(
    { env: { AMADO_KV: kv, PANEL_SALUD_REMOTO: 'true' } },
    { now: AHORA, fetchFn },
  );
  assert.equal(fetchFn.llamadas.length, 0);
  assert.equal(salud.reportes.desdeCache, true);
  assert.equal(salud.reportes.consultadoEn, '2026-09-13T20:55:00.000Z');
});

test('si GitHub no responde se dice "sin consultar", no "nunca corrió", y no se cachea', async () => {
  const kv = kvStub({ 'sync:last_ok': '2026-09-13T07:20:00.000Z' });
  const fetchFn = fetchContador(() => { throw new Error('ECONNRESET'); });
  const salud = await loadHealth(
    { env: { AMADO_KV: kv, PANEL_SALUD_REMOTO: 'true' } },
    { now: AHORA, fetchFn },
  );
  assert.ok(salud.reportes.filas.every(f => f.estado === 'no se pudo consultar'));
  assert.equal(salud.reportes.problemas.length, 1, 'un solo hecho, un solo aviso');
  assert.match(salud.reportes.problemas[0], /API de GitHub/);
  assert.equal(kv.puts.length, 0, 'un corte de red no se guarda diez minutos');
});

// ── render ──────────────────────────────────────────────────────────────────

test('fechaCorta habla en UTC y no inventa fechas', () => {
  assert.equal(fechaCorta('2026-09-13T07:20:00.000Z'), '13/09 07:20');
  assert.equal(fechaCorta('no es fecha'), '—');
  assert.equal(fechaCorta(null), '—');
});

test('la tarjeta lleva cada número con su fecha y escapa lo que viene de afuera', async () => {
  const kv = kvStub({ 'sync:last_ok': '2026-09-13T07:20:00.000Z' });
  const fetchFn = fetchContador(() => Response.json({
    workflow_runs: [{ conclusion: 'failure', created_at: '2026-09-13T09:00:00.000Z', html_url: 'https://github.com/x"><script>' }],
  }));
  const salud = await loadHealth(
    { env: { AMADO_KV: kv, PANEL_SALUD_REMOTO: 'true' } },
    { now: AHORA, fetchFn },
  );
  const html = healthSection(salud, { catalogo: { feed: { activeTotal: 7082 } } });

  assert.match(html, /id="salud"/);
  assert.match(html, /13\/09 07:20 UTC/, 'el último sync lleva su fecha');
  assert.match(html, /hace 13\.7 h/);
  assert.match(html, /7082 libros publicados/);
  assert.match(html, /13\/09 21:00 UTC/, 'la tarjeta dice cuándo se generó');
  assert.match(html, /consultado 13\/09 21:00 UTC/, 'la tabla dice cuándo se consultó');
  assert.match(html, /pastilla p-grave/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
});

test('con todo bien la tarjeta lo dice en una palabra', async () => {
  const kv = kvStub({ 'sync:last_ok': '2026-09-13T07:20:00.000Z' });
  const salud = await loadHealth(
    { env: { AMADO_KV: kv, PANEL_SALUD_REMOTO: 'true' } },
    { now: AHORA, fetchFn: fetchContador() },
  );
  const html = healthSection(salud);
  assert.match(html, /cuenta-cero">todo bien/);
  assert.match(html, /publicó a tiempo/);
  assert.doesNotMatch(html, /class="tarea t-alta"/);
});

test('un reporte verde pero viejo sale en amarillo, no en verde', async () => {
  const kv = kvStub({ 'sync:last_ok': '2026-09-13T07:20:00.000Z' });
  const salud = await loadHealth(
    { env: { AMADO_KV: kv, PANEL_SALUD_REMOTO: 'true' } },
    { now: AHORA, fetchFn: fetchContador(() => corridaOk('2026-08-12T09:00:00.000Z')) },
  );
  const html = healthSection(salud);
  assert.match(html, /pastilla p-aviso">ok</, 'ok pero viejo = aviso');
});
