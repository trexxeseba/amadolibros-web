import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CONFIRMACION_ENCENDER,
  CONFIRMACION_REQUERIDA,
  escribirAutofeed,
  explicarError,
  leerAutofeed,
  resolverAccion,
  resumen,
  urlAutofeed,
} from '../../scripts/commerce/merchant-autofeed.mjs';

const CUENTA = '5330457716';

// ─── La escritura no ocurre por accidente ────────────────────────────────────

test('sin confirmación no se escribe nada', () => {
  for (const caso of [
    { accion: 'apagar' },
    { accion: 'apagar', confirmacion: '' },
    { accion: 'apagar', confirmacion: 'apagar' },
    { accion: 'apagar', confirmacion: 'APAGA' },
    { accion: 'apagar', confirmacion: 'SI' },
    { accion: 'encender', confirmacion: 'si' },
  ]) {
    const plan = resolverAccion(caso);
    assert.equal(plan.escribe, false, JSON.stringify(caso));
    assert.equal(plan.accion, 'leer');
  }
});

test('un espacio de más en la confirmación no la invalida', () => {
  // La confirmación existe para que la escritura sea deliberada, no para
  // castigar un espacio pegado de más. Lo que NO se acepta es otra palabra ni
  // otra capitalización, y eso lo fija la prueba de arriba.
  assert.equal(resolverAccion({ accion: 'apagar', confirmacion: ' APAGAR ' }).escribe, true);
});

test('leer es la acción por defecto y nunca escribe', () => {
  for (const caso of [{}, { accion: '' }, { accion: 'leer' }, { accion: 'leer', confirmacion: 'APAGAR' }]) {
    assert.equal(resolverAccion(caso).escribe, false, JSON.stringify(caso));
  }
});

test('una confirmación de otra acción no habilita la escritura', () => {
  // Escribir APAGAR no puede encender el autofeed, ni al revés.
  assert.equal(resolverAccion({ accion: 'encender', confirmacion: CONFIRMACION_REQUERIDA }).escribe, false);
  assert.equal(resolverAccion({ accion: 'apagar', confirmacion: CONFIRMACION_ENCENDER }).escribe, false);
});

test('una acción desconocida no escribe', () => {
  const plan = resolverAccion({ accion: 'borrar_todo', confirmacion: CONFIRMACION_REQUERIDA });
  assert.equal(plan.escribe, false);
  assert.match(plan.motivo, /desconocida/i);
});

test('con la palabra exacta sí se escribe, y con el valor correcto', () => {
  const apagar = resolverAccion({ accion: 'apagar', confirmacion: CONFIRMACION_REQUERIDA });
  assert.deepEqual(apagar, { escribe: true, accion: 'apagar', enableProducts: false });

  const encender = resolverAccion({ accion: 'encender', confirmacion: CONFIRMACION_ENCENDER });
  assert.deepEqual(encender, { escribe: true, accion: 'encender', enableProducts: true });
});

// ─── La ruta de la API ───────────────────────────────────────────────────────

test('la URL usa v1, no la v1beta apagada, y el updateMask correcto', () => {
  const lectura = urlAutofeed(CUENTA);
  assert.equal(lectura, `https://merchantapi.googleapis.com/accounts/v1/accounts/${CUENTA}/autofeedSettings`);
  assert.doesNotMatch(lectura, /v1beta/, 'v1beta se apagó el 28/02/2026');

  const escritura = urlAutofeed(CUENTA, { updateMask: 'enableProducts' });
  assert.equal(escritura, `${lectura}?updateMask=enableProducts`);
});

// ─── Los pedidos HTTP reales que se emiten ───────────────────────────────────

function fetchFalso(respuesta = {}, { status = 200 } = {}) {
  const llamadas = [];
  const fn = async (url, opciones) => {
    llamadas.push({ url, ...opciones });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(respuesta),
    };
  };
  return { fn, llamadas };
}

test('leer usa GET y no manda cuerpo', async () => {
  const { fn, llamadas } = fetchFalso({ enableProducts: true, eligible: true });
  const datos = await leerAutofeed({ accountId: CUENTA, accessToken: 'tok', fetchFn: fn });
  assert.equal(datos.enableProducts, true);
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].method, 'GET');
  assert.equal(llamadas[0].body, undefined);
  assert.equal(llamadas[0].headers.Authorization, 'Bearer tok');
});

test('apagar manda PATCH con enableProducts en false', async () => {
  const { fn, llamadas } = fetchFalso({ enableProducts: false });
  await escribirAutofeed({ accountId: CUENTA, accessToken: 'tok', enableProducts: false, fetchFn: fn });
  assert.equal(llamadas[0].method, 'PATCH');
  assert.match(llamadas[0].url, /updateMask=enableProducts/);
  assert.deepEqual(JSON.parse(llamadas[0].body), { enableProducts: false });
});

// ─── Errores que no son errores de código ────────────────────────────────────

test('un 403 al escribir se explica como permiso, no como falla del script', () => {
  const mensaje = explicarError({ status: 403 }, { escribiendo: true });
  assert.match(mensaje, /administrador/i);
  assert.match(mensaje, /No es un problema del script/);
});

test('un 400 que menciona v1beta apunta a la ruta vieja', () => {
  assert.match(explicarError({ status: 400, message: 'v1beta not found' }), /v1beta se apagó/);
});

// ─── El informe dice la verdad ───────────────────────────────────────────────

test('el resumen no dice «aplicado» si el valor no cambió', () => {
  const plan = { escribe: true, accion: 'apagar', enableProducts: false };
  const texto = resumen({
    accountId: CUENTA, plan,
    antes: { enableProducts: false },
    despues: { enableProducts: false },
  });
  assert.doesNotMatch(texto, /El cambio se aplicó/);
  assert.match(texto, /no cambió/);
});

test('el resumen de un apagado real incluye cómo revertirlo', () => {
  const plan = { escribe: true, accion: 'apagar', enableProducts: false };
  const texto = resumen({
    accountId: CUENTA, plan,
    antes: { enableProducts: true, eligible: true },
    despues: { enableProducts: false },
  });
  assert.match(texto, /El cambio se aplicó/);
  assert.match(texto, /accion: encender/);
  assert.match(texto, /24 horas/);
});

test('el resumen informa el fallo en vez de callarlo', () => {
  const texto = resumen({
    accountId: CUENTA,
    plan: { escribe: true, accion: 'apagar' },
    antes: null, despues: null,
    error: 'HTTP 403: sin permiso',
  });
  assert.match(texto, /No se completó/);
  assert.match(texto, /403/);
});

// ─── El contrato de sólo lectura de la auditoría sigue intacto ────────────────

test('la auditoría de Merchant sigue sin escribir', () => {
  // Esta escritura vive en un archivo aparte justamente para no romper esa
  // garantía. Si alguien mueve el PATCH al script de auditoría, esto falla.
  const auditoria = readFileSync('scripts/commerce/merchant-readonly-audit.mjs', 'utf8');
  assert.doesNotMatch(auditoria, /method\s*:\s*['"](?:POST|PATCH|PUT|DELETE)['"]/i);
});
