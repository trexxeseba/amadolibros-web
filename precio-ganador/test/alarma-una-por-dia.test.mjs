import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.PRECIO_GANADOR_SOLO_IMPORTAR = '1';
process.argv.push('--cuenta', 'vintage');
const { enviarAlarma, claveAlarma } = await import('../src/alarma.mjs');
const { motivosDeFalla, precioParaGanar } = await import('../src/auditoria.mjs');

test('la misma alarma el mismo día da la misma clave, aunque cambien los números', () => {
  const dia = '2026-11-25T23:00:00.000Z';
  assert.equal(claveAlarma('falló la corrida (libros)', dia), claveAlarma('falló la corrida (libros)', dia));
  assert.equal(claveAlarma('no corre bien desde hace 7 horas', dia), claveAlarma('no corre bien desde hace 9 horas', dia));
  assert.notEqual(claveAlarma('falló la corrida (libros)', dia), claveAlarma('falló la corrida (vintage)', dia));
  assert.notEqual(claveAlarma('falló la corrida (libros)', dia), claveAlarma('falló la corrida (libros)', '2026-11-26T23:00:00.000Z'));
});

test('M2a (26/11): sin ALARMAS_POR_MAIL=si no manda nada ni llama a la red', async () => {
  let llamadas = 0;
  const r = await enviarAlarma({ asunto: 'falló la corrida (libros)', texto: 'x', env: { RESEND_API_KEY: 'x', PRECIO_GANADOR_EMAIL_TO: 'a@b.c' }, fetcher: async () => { llamadas++; return { ok: true, status: 200 }; } });
  assert.equal(r.status, 'sin_mail_por_regla'); assert.equal(llamadas, 0);
});

test('M3a: con el registro del repo privado, el segundo aviso del mismo problema no sale; lleva APP/PROYECTO/COMETIDO', async () => {
  const env = { ALARMAS_POR_MAIL: 'si', RESEND_API_KEY: 'x', PRECIO_GANADOR_EMAIL_TO: 'a@b.c', ESTADO_TOKEN: 't' };
  const creados = new Set(); const mails = [];
  const fetcher = async (u, o) => {
    if (u.startsWith('https://api.github.com/')) { const k = u.split('/contents/')[1]; if (creados.has(k)) return { status: 422 }; creados.add(k); return { status: 201 }; }
    mails.push(JSON.parse(o.body)); return { ok: true, status: 200 };
  };
  assert.equal((await enviarAlarma({ asunto: 'no corre bien desde hace 9 horas', texto: 'a', env, fetcher })).status, 'enviado');
  assert.equal((await enviarAlarma({ asunto: 'no corre bien desde hace 12 horas', texto: 'b', env, fetcher })).status, 'ya_avisado');
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /^APP: .+\nPROYECTO: .+\nCOMETIDO: /);
  assert.match(mails[0].text, /Cómo desactivarlo o modificarlo/);
  assert.match(mails[0].html, /<b>APP: /);
});

test('18 cambiadas sobre 9.808 en el estado es aviso; 18 sobre 500 sigue tumbando', () => {
  const base = { porTipo: { muestra: 0, estado: 18, regla: 0 }, muestraN: 10, erroresAplicar: 0, intentos: 0 };
  assert.deepEqual(motivosDeFalla({ ...base, estadoN: 9808 }), []);
  assert.equal(motivosDeFalla({ ...base, estadoN: 500 }).length, 1);
});

test('un 403 en price_to_win deja la publicación sin leer y no tumba la auditoría', async () => {
  const falla = status => ({ get: async () => { throw Object.assign(new Error('x'), { status }); } });
  assert.equal(await precioParaGanar('MLU1', falla(403)), null);
  await assert.rejects(precioParaGanar('MLU1', falla(500)));
});
