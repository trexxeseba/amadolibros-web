import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluarCierre } from '../../scripts/seo/verificacion-produccion-gate.mjs';

// Estas pruebas ejercitan la MISMA función que corre el workflow, no una
// copia: el paso del workflow es `node scripts/seo/verificacion-produccion-gate.mjs`.

function diff({ perdidas = 0, conPerdida = [] } = {}) {
  return { totales: { fichas_que_pierden_algun_campo: perdidas }, fichas_con_perdida: conPerdida };
}

function validacion({ esperadas, verificadas, fallidas = 0, sinVerificar = 0, comprobaciones, noVerificadas = [] }) {
  return {
    totales: {
      fichas_esperadas: esperadas,
      verificadas,
      fallidas,
      no_verificadas: sinVerificar,
      comprobaciones_totales: comprobaciones,
    },
    no_verificadas: noVerificadas,
  };
}

const motivos = resultado => resultado.motivos.join(' | ');

test('todo correcto: aprueba', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({ esperadas: 481, verificadas: 481, comprobaciones: 841 }),
  });
  assert.equal(r.ok, true, motivos(r));
  assert.deepEqual(r.motivos, []);
  assert.equal(r.resumen.verificadas, 481);
  assert.equal(r.resumen.comprobaciones, 841);
});

// --- Los tres falsos positivos que reprodujo la revisión ---

test('todas las fichas en HTTP 404: NO aprueba', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({
      esperadas: 481, verificadas: 0, sinVerificar: 481, comprobaciones: 0,
      noVerificadas: [{ id: 'MLU1', isbn: '9780000000001', status: 404, motivo: 'HTTP 404' }],
    }),
  });
  assert.equal(r.ok, false, 'no verificar ninguna ficha no puede ser un éxito');
  assert.match(motivos(r), /SIN VERIFICAR/);
  assert.match(motivos(r), /Ninguna ficha quedó verificada/);
  assert.match(motivos(r), /cero comprobaciones/);
  // El 404 se informa, pero no se le inventa una causa.
  assert.doesNotMatch(motivos(r), /catálogo|baja|pausad/i);
});

test('todas las fichas en HTTP 500: NO aprueba', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({
      esperadas: 481, verificadas: 0, sinVerificar: 481, comprobaciones: 0,
      noVerificadas: [{ id: 'MLU1', isbn: '9780000000001', status: 500, motivo: 'HTTP 500' }],
    }),
  });
  assert.equal(r.ok, false, 'un sitio caído no puede aprobar la corrida');
  assert.match(motivos(r), /SIN VERIFICAR/);
});

test('plan vacío: NO aprueba', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({ esperadas: 0, verificadas: 0, comprobaciones: 0 }),
  });
  assert.equal(r.ok, false, 'un plan vacío no prueba nada');
  assert.match(motivos(r), /plan no contiene ninguna ficha/i);
});

// --- El resto del contrato ---

test('una ficha correcta y otra sin verificar: NO aprueba', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({
      esperadas: 2, verificadas: 1, sinVerificar: 1, comprobaciones: 3,
      noVerificadas: [{ id: 'MLU2', isbn: '9780000000002', status: 404, motivo: 'HTTP 404' }],
    }),
  });
  assert.equal(r.ok, false, 'una sola ficha sin mirar ya impide aprobar');
  assert.match(motivos(r), /Sólo 1 de 2 fichas/);
  assert.match(motivos(r), /SIN VERIFICAR/);
  // La ficha sin verificar sigue contada entre las esperadas: no se la excluye
  // para que el número cierre. El resumen conserva las cifras medidas aunque
  // la corrida falle, que es lo que hace falta para revisarla.
  assert.equal(r.resumen.esperadas, 2);
  assert.equal(r.resumen.sin_verificar, 1);
  assert.equal(r.resumen.verificadas, 1);
});

test('una ficha fallida: NO aprueba', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({ esperadas: 481, verificadas: 480, fallidas: 1, comprobaciones: 840 }),
  });
  assert.equal(r.ok, false);
  assert.match(motivos(r), /1 ficha\(s\) no muestran lo prometido/);
});

test('pérdida de un campo: NO aprueba aunque todas las fichas se verifiquen', () => {
  const r = evaluarCierre({
    diff: diff({ perdidas: 1, conPerdida: [{ id: 'MLU9', isbn: '9780000000009', perdidos: ['topics'] }] }),
    validacion: validacion({ esperadas: 481, verificadas: 481, comprobaciones: 841 }),
  });
  assert.equal(r.ok, false, 'perder un dato publicado es una regresión');
  assert.match(motivos(r), /perdieron algún campo/);
});

test('informe ausente: NO aprueba', () => {
  const sinValidacion = evaluarCierre({ diff: diff(), validacion: null });
  assert.equal(sinValidacion.ok, false);
  assert.match(motivos(sinValidacion), /Falta el informe de verificación/);

  const sinDiff = evaluarCierre({
    diff: null,
    validacion: validacion({ esperadas: 481, verificadas: 481, comprobaciones: 841 }),
  });
  assert.equal(sinDiff.ok, false);
  assert.match(motivos(sinDiff), /Falta el informe de reconciliación/);

  const sinNada = evaluarCierre({});
  assert.equal(sinNada.ok, false);
  assert.equal(sinNada.motivos.length, 2);
});

test('un informe al que le falta una cifra no se lee como cero', () => {
  const r = evaluarCierre({
    diff: diff(),
    // Sin `no_verificadas`: antes eso se leía como 0 y dejaba pasar.
    validacion: { totales: { fichas_esperadas: 481, verificadas: 481, fallidas: 0, comprobaciones_totales: 841 } },
  });
  assert.equal(r.ok, false);
  assert.match(motivos(r), /falta "no_verificadas"/);
});

test('un informe cuyas partes no suman no aprueba', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({ esperadas: 481, verificadas: 481, fallidas: 0, sinVerificar: 0, comprobaciones: 841 }),
  });
  assert.equal(r.ok, true, 'control: éste sí suma');

  const roto = evaluarCierre({
    diff: diff(),
    validacion: validacion({ esperadas: 500, verificadas: 481, comprobaciones: 841 }),
  });
  assert.equal(roto.ok, false);
  assert.match(motivos(roto), /no suman las 500 esperadas/);
});

test('cero comprobaciones no aprueba aunque las fichas figuren verificadas', () => {
  const r = evaluarCierre({
    diff: diff(),
    validacion: validacion({ esperadas: 481, verificadas: 481, comprobaciones: 0 }),
  });
  assert.equal(r.ok, false, 'sin comprobaciones no hay nada comprobado');
  assert.match(motivos(r), /cero comprobaciones/);
});
