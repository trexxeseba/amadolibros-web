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

test('manda la clave de idempotencia y toma el 409 como "ya avisado"', async () => {
  process.env.RESEND_API_KEY = 'x'; process.env.PRECIO_GANADOR_EMAIL_TO = 'a@b.c';
  const vistas = [];
  const fetcher = async (_u, o) => { vistas.push(o.headers['Idempotency-Key']); return { ok: vistas.length === 1, status: vistas.length === 1 ? 200 : 409 }; };
  assert.equal((await enviarAlarma({ asunto: 'falló la corrida (libros)', texto: 'run 1', fetcher })).status, 'enviado');
  assert.equal((await enviarAlarma({ asunto: 'falló la corrida (libros)', texto: 'run 2', fetcher })).status, 'ya_avisado');
  assert.equal(vistas[0], vistas[1]);
  assert.match(vistas[0], /^precio-ganador-alarma\/\d{4}-\d{2}-\d{2}\/fallo-la-corrida-libros$/);
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
