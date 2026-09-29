import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldKeepProbes, pruneEntryProbes } from '../_shared/cover-probe-retention.js';
import { GOOGLE_IMAGE_MIN_EDGE } from '../_shared/image-source-policy.js';

const SONDEOS = [
  { at: '2026-09-09T04:12:31Z', url: 'https://x/-O.webp', status: 200, width: 300, height: 400, chosen: false },
  { at: '2026-09-09T04:12:32Z', url: 'https://x/-F.webp', status: 200, width: 480, height: 640, chosen: true },
];

function entrada({ ancho, alto, conCopia = true, sondeos = SONDEOS } = {}) {
  return {
    product_id: 'MLU600000001', position: 0,
    ...(conCopia ? { current: { object_key: 'covers/v1/o/x.jpg', sha256: 'a'.repeat(64),
      mime: 'image/jpeg', source_url: 'https://x/-F.webp', width: ancho, height: alto, bytes: 1000 } } : {}),
    last_validated_at: '2026-09-09T04:12:33Z',
    source_policy_version: 3,
    source_probes: sondeos,
  };
}

test('la portada que todavía no llega a 500px conserva su historial', () => {
  // Es exactamente la que el reporte de calidad lista en needs_better_source,
  // y el historial es lo que explica por qué no se consiguió algo mejor.
  const chica = entrada({ ancho: 480, alto: 640 });
  assert.equal(shouldKeepProbes(chica), true);
  assert.equal(pruneEntryProbes(chica), chica, 'no se toca, ni siquiera se copia');
  assert.deepEqual(pruneEntryProbes(chica).source_probes, SONDEOS);
});

test('la portada que ya llegó a 500px pierde el historial que nadie lee', () => {
  const grande = entrada({ ancho: GOOGLE_IMAGE_MIN_EDGE, alto: 1200 });
  assert.equal(shouldKeepProbes(grande), false);
  const podada = pruneEntryProbes(grande);
  assert.ok(!('source_probes' in podada));
  // Y NADA más se pierde: lo que decide el trabajo del cron sigue entero.
  for (const campo of ['product_id', 'position', 'current', 'last_validated_at', 'source_policy_version']) {
    assert.deepEqual(podada[campo], grande[campo], `se perdió ${campo}`);
  }
});

test('un sondeo con error se conserva aunque la portada haya quedado bien', () => {
  // Lo encontró un test que ya existía: si una variante de la fuente se cayó
  // pero otra anduvo, la portada termina grande y el historial es lo único que
  // registra que hubo un problema. Sin eso no hay forma de saber que quizás
  // había una imagen mejor detrás de la variante caída.
  const conError = entrada({ ancho: 1200, alto: 1600, sondeos: [
    { at: '2026-09-09T04:12:31Z', url: 'https://x/-O.jpg', error: 'HTTP 503' },
    { at: '2026-09-09T04:12:32Z', url: 'https://x/-F.webp', status: 200, width: 1200, height: 1600, chosen: true },
  ] });
  assert.equal(shouldKeepProbes(conError), true);
  assert.equal(pruneEntryProbes(conError), conError);

  // También si el error quedó sólo como estado HTTP, sin campo `error`.
  const soloEstado = entrada({ ancho: 1200, alto: 1600, sondeos: [
    { at: '2026-09-09T04:12:31Z', url: 'https://x/-O.jpg', status: 404 },
    { at: '2026-09-09T04:12:32Z', url: 'https://x/-F.webp', status: 200, width: 1200, height: 1600, chosen: true },
  ] });
  assert.equal(shouldKeepProbes(soloEstado), true);

  // Pero todo bien y grande sí se poda: no hay nada que investigar.
  assert.equal(shouldKeepProbes(entrada({ ancho: 1200, alto: 1600 })), false);
});

test('sondeos con formas raras no se toman por errores ni rompen', () => {
  for (const sondeos of [null, undefined, 'nada', [null], [42], [{}], [{ status: 'ok' }]]) {
    const registro = entrada({ ancho: 1200, alto: 1600, sondeos });
    assert.doesNotThrow(() => shouldKeepProbes(registro));
    assert.equal(shouldKeepProbes(registro), false,
      `${JSON.stringify(sondeos)} no registra ningún error`);
  }
});

test('el borde de los 500px se respeta exactamente', () => {
  // Un pixel de menos en cualquiera de los dos lados y todavía hace falta.
  assert.equal(shouldKeepProbes(entrada({ ancho: GOOGLE_IMAGE_MIN_EDGE - 1, alto: 2000 })), true);
  assert.equal(shouldKeepProbes(entrada({ ancho: 2000, alto: GOOGLE_IMAGE_MIN_EDGE - 1 })), true);
  assert.equal(shouldKeepProbes(entrada({ ancho: GOOGLE_IMAGE_MIN_EDGE, alto: GOOGLE_IMAGE_MIN_EDGE })), false);
});

test('sin copia todavía, el historial es lo único que explica qué pasó', () => {
  // Una entrada que falló no tiene `current`. Ahí el historial es el
  // diagnóstico entero: se conserva siempre.
  assert.equal(shouldKeepProbes(entrada({ conCopia: false })), true);
  assert.equal(shouldKeepProbes({ current: null, source_probes: SONDEOS }), true);
  assert.equal(shouldKeepProbes({ current: {}, source_probes: SONDEOS }), true);
  assert.equal(shouldKeepProbes({ current: { object_key: '' }, source_probes: SONDEOS }), true);
});

test('una entrada sin historial no se toca ni se copia', () => {
  const sinSondeos = { product_id: 'MLU1', position: 0,
    current: { object_key: 'k', width: 1200, height: 1600 } };
  assert.equal(pruneEntryProbes(sinSondeos), sinSondeos);
});

test('formas raras no rompen la poda', () => {
  for (const valor of [null, undefined, 'texto', 42, []]) {
    assert.doesNotThrow(() => pruneEntryProbes(valor));
    assert.equal(pruneEntryProbes(valor), valor);
  }
});

test('el reporte de calidad no pierde ni una sola de las que mira', () => {
  // Éste es el test que importa. `needs_better_source` se arma con
  // `current.object_key && !googleFutureReadyImage(current)`. Después de
  // podar, TODAS esas tienen que seguir teniendo su historial.
  let miradas = 0;
  for (let i = 0; i < 200; i++) {
    const lado = 300 + i * 3;
    const registro = entrada({ ancho: lado, alto: lado + 40 });
    const enElReporte = Math.min(lado, lado + 40) < GOOGLE_IMAGE_MIN_EDGE;
    if (enElReporte) miradas += 1;
    const podado = pruneEntryProbes(registro);
    if (enElReporte) {
      assert.deepEqual(podado.source_probes, SONDEOS,
        `${lado}px está en el reporte y se quedó sin historial`);
    }
  }
  assert.ok(miradas > 0 && miradas < 200, 'la muestra tiene de las dos');
});

test('podar es idempotente: hacerlo de nuevo no copia nada', () => {
  const grande = entrada({ ancho: 1200, alto: 1600 });
  const unaVez = pruneEntryProbes(grande);
  assert.notEqual(unaVez, grande);
  assert.equal(pruneEntryProbes(unaVez), unaVez, 'la segunda pasada no crea otro objeto');
});
