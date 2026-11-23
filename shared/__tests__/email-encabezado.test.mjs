import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESOS, envolverMail, encabezadoHtml } from '../email-encabezado.js';

test('todo proceso tiene app, proyecto, cometido en mayúscula, y cómo apagarlo y modificarlo', () => {
  for (const [id, p] of Object.entries(PROCESOS)) {
    assert.ok(p.app && p.proyecto, `${id}: falta app o proyecto`);
    assert.equal(p.cometido, p.cometido.toUpperCase(), `${id}: el cometido va en mayúscula`);
    assert.ok(p.apagar.length > 0 && p.modificar.length > 0, `${id}: falta apagar o modificar`);
  }
});

test('el texto lleva APP, PROYECTO, COMETIDO arriba y CÓMO DESACTIVARLO O MODIFICARLO abajo', () => {
  const { text } = envolverMail({ proceso: 'guardian', texto: 'Hay algo que mirar.' });
  assert.ok(text.startsWith('APP: '));
  assert.ok(text.indexOf('PROYECTO:') < text.indexOf('COMETIDO:'));
  assert.ok(text.indexOf('COMETIDO:') < text.indexOf('Hay algo que mirar.'));
  assert.ok(text.indexOf('Hay algo que mirar.') < text.indexOf('CÓMO DESACTIVARLO O MODIFICARLO'));
  assert.match(text, /HERMES_APAGADO/);
});

test('en el HTML el cometido va en negrita', () => {
  assert.match(encabezadoHtml('poda'), /<b>COMETIDO: [A-ZÁÉÍÓÚÑ ,.()0-9]+<\/b>/);
});

test('si el HTML ya es un documento, encabezado y pie quedan dentro del body y se escapa el texto', () => {
  const { html } = envolverMail({ proceso: 'premio', texto: 'x', html: '<!doctype html><html><body style="a"><p>Premio</p></body></html>' });
  assert.ok(html.startsWith('<!doctype html><html><body style="a"><div'));
  assert.ok(html.endsWith('</div></body></html>'));
  assert.equal(html.match(/<body/g).length, 1);
  const crudo = envolverMail({ proceso: 'poda', texto: '<script>' });
  assert.ok(!crudo.html.includes('<script>'));
});

test('un proceso inexistente falla fuerte, no manda un mail sin encabezado', () => {
  assert.throws(() => envolverMail({ proceso: 'no-existe', texto: 'x' }), /proceso desconocido/);
});

test('sendMail de los avisos de Vintage manda el proceso correcto según el prefijo', async () => {
  const { sendMail } = await import('../../scripts/vintage-cloud/aviso.mjs');
  const casos = [['Guardián', 'guardian'], ['Vintage nube', 'vintage-nube'], ['Vintage parte', 'vintage-parte'], ['Competencia ML', 'competencia-ml']];
  for (const [prefijo, proceso] of casos) {
    let enviado = null;
    const r = await sendMail({
      asunto: 'prueba', texto: 'Cuerpo del aviso', prefijo,
      env: { RESEND_API_KEY: 'k', VINTAGE_EMAIL_TO: 'a@b.c' },
      fetcher: async (url, init) => { enviado = JSON.parse(init.body); return { ok: true }; },
    });
    assert.equal(r, 'enviado');
    assert.equal(enviado.subject, `${prefijo}: prueba`);
    assert.ok(enviado.text.includes(`PROYECTO: ${PROCESOS[proceso].proyecto}`), prefijo);
    assert.ok(enviado.text.includes('Cuerpo del aviso'));
    assert.match(enviado.html, new RegExp(`<b>COMETIDO: ${PROCESOS[proceso].cometido.replace(/[()]/g, '\\$&')}</b>`));
  }
});
