import test from 'node:test';
import assert from 'node:assert/strict';

import {
  WORKFLOWS_VIGILADOS,
  construirDigest,
  evaluarWorkflows,
} from '../../scripts/ops/health-digest.mjs';
import {
  markdownToHtml,
  resolveEmailConfig,
  sendReportEmail,
} from '../../scripts/ops/send-report-email.mjs';

const AHORA = new Date('2026-09-13T21:00:00.000Z');

const VIGILADOS = [
  { archivo: 'a.yml', nombre: 'Reporte diario', maxDias: 2, rama: 'main' },
  { archivo: 'b.yml', nombre: 'Deploy', maxDias: null, rama: 'main' },
];

test('una corrida reciente y verde no genera aviso', () => {
  const { filas, problemas } = evaluarWorkflows(
    { 'a.yml': { ok: true, corrida: { conclusion: 'success', created_at: '2026-09-13T09:00:00.000Z' } } },
    { now: AHORA, vigilados: [VIGILADOS[0]] },
  );
  assert.equal(problemas.length, 0);
  assert.equal(filas[0].ok, true);
  assert.equal(filas[0].estado, 'success');
});

test('una corrida fallida genera aviso', () => {
  const { problemas } = evaluarWorkflows(
    { 'a.yml': { ok: true, corrida: { conclusion: 'failure', created_at: '2026-09-13T09:00:00.000Z' } } },
    { now: AHORA, vigilados: [VIGILADOS[0]] },
  );
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /falló/);
});

// El modo de fallar más fácil de no notar: la tarea no falla, deja de correr.
test('un reporte que dejó de correr genera aviso aunque su última corrida fuera verde', () => {
  const { problemas, filas } = evaluarWorkflows(
    { 'a.yml': { ok: true, corrida: { conclusion: 'success', created_at: '2026-08-12T09:00:00.000Z' } } },
    { now: AHORA, vigilados: [VIGILADOS[0]] },
  );
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /no corre hace 32\.5 días/);
  assert.equal(filas[0].ok, false);
});

test('un workflow sin límite de antigüedad no avisa por viejo', () => {
  const { problemas } = evaluarWorkflows(
    { 'b.yml': { ok: true, corrida: { conclusion: 'success', created_at: '2026-07-01T09:00:00.000Z' } } },
    { now: AHORA, vigilados: [VIGILADOS[1]] },
  );
  assert.equal(problemas.length, 0);
});

test('un workflow sin ninguna corrida se avisa, no se ignora', () => {
  const { problemas, filas } = evaluarWorkflows({ 'a.yml': { ok: true, corrida: null } }, { now: AHORA, vigilados: [VIGILADOS[0]] });
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /no tiene ninguna corrida/);
  assert.equal(filas[0].estado, 'sin corridas');
});

test('cancelled y skipped no se reportan como falla', () => {
  const { problemas } = evaluarWorkflows(
    { 'a.yml': { ok: true, corrida: { conclusion: 'skipped', created_at: '2026-09-13T09:00:00.000Z' } } },
    { now: AHORA, vigilados: [VIGILADOS[0]] },
  );
  assert.equal(problemas.length, 0);
});

test('la lista vigilada no incluye las sondas temporales del repo', () => {
  const archivos = WORKFLOWS_VIGILADOS.map(wf => wf.archivo).join(' ');
  assert.equal(/temporary|probe|bootstrap|diagnostic/i.test(archivos), false);
  assert.ok(WORKFLOWS_VIGILADOS.length <= 10, 'la gracia es que sean pocos y se lean');
});

test('el digest arranca por lo que está roto', () => {
  const { markdown, hayProblemas } = construirDigest({
    estadoSync: { problemas: ['El sync no publica hace 40 h.'], notas: [], edadHoras: 40, lastOk: 'x', totalItems: 7082 },
    workflows: evaluarWorkflows(
      { 'a.yml': { ok: true, corrida: { conclusion: 'failure', created_at: '2026-09-13T09:00:00.000Z' } } },
      { now: AHORA, vigilados: [VIGILADOS[0]] },
    ),
    now: AHORA,
  });

  assert.equal(hayProblemas, true);
  assert.match(markdown, /Hay 2 cosa\(s\) para mirar/);
  assert.ok(markdown.indexOf('para mirar') < markdown.indexOf('## Catálogo'), 'los problemas van antes que los números');
});

test('sin problemas el digest lo dice en una línea y sigue mostrando los datos', () => {
  const { markdown, hayProblemas } = construirDigest({
    estadoSync: { problemas: [], notas: [], edadHoras: 13.7, lastOk: '2026-09-13T07:20:00.000Z', totalItems: 7082 },
    workflows: evaluarWorkflows(
      { 'a.yml': { ok: true, corrida: { conclusion: 'success', created_at: '2026-09-13T09:00:00.000Z' } } },
      { now: AHORA, vigilados: [VIGILADOS[0]] },
    ),
    now: AHORA,
  });

  assert.equal(hayProblemas, false);
  assert.match(markdown, /Todo en orden/);
  assert.match(markdown, /7082/);
});

test('el HTML del correo escapa lo que viene de afuera antes de marcarlo', () => {
  const html = markdownToHtml('## <script>alert(1)</script>\n\n- **negrita** y `code`\n');
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>negrita<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
});

test('el HTML del correo arma tablas de verdad', () => {
  const html = markdownToHtml('| Reporte | Estado |\n| --- | --- |\n| Deploy | success |\n');
  assert.match(html, /<th>Reporte<\/th>/);
  assert.match(html, /<td>success<\/td>/);
  assert.equal(html.includes('---'), false, 'el separador de markdown no se imprime');
});

test('sin credenciales no se manda nada y se dice cuál falta', () => {
  assert.equal(resolveEmailConfig({}).ok, false);
  assert.match(resolveEmailConfig({}).motivo, /RESEND_API_KEY/);

  const sinDestino = resolveEmailConfig({ RESEND_API_KEY: 'k', SALES_NOTIFICATION_FROM: 'a@b.c' });
  assert.equal(sinDestino.ok, false);
  assert.match(sinDestino.motivo, /REPORT_EMAIL_TO/);
});

test('la configuración acepta varios destinatarios separados por coma', () => {
  const config = resolveEmailConfig({
    RESEND_API_KEY: 'k',
    SALES_NOTIFICATION_FROM: 'Amado <web@x.com>',
    SALES_NOTIFICATION_TO: 'uno@x.com, dos@x.com',
  });
  assert.equal(config.ok, true);
  assert.deepEqual(config.to, ['uno@x.com', 'dos@x.com']);
});

test('el envío manda texto y HTML, y reporta el error de Resend sin tragárselo', async () => {
  let enviado = null;
  const okResult = await sendReportEmail({
    subject: 'Informe',
    markdown: '# Hola',
    config: { apiKey: 'k', from: 'a@b.c', to: ['d@e.f'] },
    fetchFn: async (url, init) => { enviado = JSON.parse(init.body); return { ok: true }; },
  });
  assert.equal(okResult.ok, true);
  assert.equal(enviado.text, '# Hola');
  assert.match(enviado.html, /<h1>Hola<\/h1>/);
  assert.deepEqual(enviado.to, ['d@e.f']);

  const falla = await sendReportEmail({
    subject: 'Informe',
    markdown: '# Hola',
    config: { apiKey: 'k', from: 'a@b.c', to: ['d@e.f'] },
    fetchFn: async () => ({ ok: false, status: 422, text: async () => 'dominio no verificado' }),
  });
  assert.equal(falla.ok, false);
  assert.equal(falla.code, 'RESEND_HTTP_422');
  assert.match(falla.detalle, /dominio no verificado/);
});

// Un corte de red no puede leerse como "tus reportes están muertos": son
// hechos distintos y el aviso en falso es lo que hace que dejen de leerse.
test('no poder consultar la API no se confunde con que el reporte no corrió', () => {
  const { problemas, filas } = evaluarWorkflows(
    { 'a.yml': { ok: false, error: 'error de red' } },
    { now: AHORA, vigilados: [VIGILADOS[0]] },
  );
  assert.equal(filas[0].estado, 'no se pudo consultar');
  assert.equal(filas[0].ok, false);
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /No se pudo consultar/);
  assert.equal(/no tiene ninguna corrida|no corre hace/.test(problemas[0]), false);
});

test('si no se pudo consultar ninguno, el aviso es uno solo y no uno por reporte', () => {
  const { problemas } = evaluarWorkflows(
    { 'a.yml': { ok: false, error: 'x' }, 'b.yml': { ok: false, error: 'x' } },
    { now: AHORA, vigilados: VIGILADOS },
  );
  assert.equal(problemas.length, 1, 'un solo hecho, un solo aviso');
  assert.match(problemas[0], /API de GitHub/);
});

test('si falló sólo uno, se nombra ese y no se generaliza', () => {
  const { problemas } = evaluarWorkflows(
    {
      'a.yml': { ok: false, error: 'x' },
      'b.yml': { ok: true, corrida: { conclusion: 'success', created_at: '2026-09-13T09:00:00.000Z' } },
    },
    { now: AHORA, vigilados: VIGILADOS },
  );
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /«Reporte diario»/);
});
