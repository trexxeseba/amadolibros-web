import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coverManifestBudget,
  coverBudgetMessage,
  ISOLATE_LIMIT_MB,
  GRAPH_PER_JSON_MB,
  ENTRIES_COPY_BYTES_PER_ENTRY,
  PROVEN_MANIFEST_BYTES,
  PROVEN_MANIFEST_ENTRIES,
  WARN_OVER_PROVEN,
  CRITICAL_OVER_PROVEN,
  SHARD_BUFFERS_MB,
  WORKER_BASELINE_MB,
} from '../_shared/cover-manifest-budget.js';

const MB = 1024 * 1024;

// La medición real del manifest de producción, hecha con JSON.parse, que es
// lo que hace el Worker.
const MEDIDO = { graph_mb: 133.8, entries_copy_mb: 2.4, graph_per_json: 1.25 };

test('el tamaño probado no dispara nada, aunque el modelo diga que no entra', () => {
  // Éste es el test que le pone freno a dos falsos positivos seguidos. En la
  // corrida 34521572816 un Worker real completó el sync a este tamaño DOS
  // veces, con conflicto CAS y reconstrucción entera. El modelo decía 122%
  // del isolate. Ganó la prueba, no el modelo.
  const budget = coverManifestBudget({
    manifestBytes: PROVEN_MANIFEST_BYTES, entries: PROVEN_MANIFEST_ENTRIES, measured: MEDIDO,
  });
  assert.equal(budget.level, 'ok');
  assert.equal(budget.over_proven_x, 1);
  // Y el modelo, que sigue diciendo que no entra, queda a la vista sin mandar.
  assert.equal(budget.modelled_level, 'critical');
  assert.equal(budget.modelled_over_isolate, true);

  const aviso = coverBudgetMessage(budget);
  assert.match(aviso, /Dentro del terreno probado/);
  assert.doesNotMatch(aviso, /CRÍTICO|AVISO/);
});

test('el mensaje nunca anuncia una muerte que no está ocurriendo', () => {
  // Un guardián que dice "esto se muere" mientras el sitio funciona se quema
  // para siempre: nadie le va a creer el día que tenga razón.
  for (const factor of [1, WARN_OVER_PROVEN, CRITICAL_OVER_PROVEN, 3]) {
    const aviso = coverBudgetMessage(coverManifestBudget({
      manifestBytes: Math.round(PROVEN_MANIFEST_BYTES * factor), entries: 90000,
    }));
    assert.doesNotMatch(aviso, /está por morir|va a morir|YA se pasa del isolate/,
      `a ${factor}x del tamaño probado el mensaje no puede anunciar una muerte`);
  }
});

test('la cota modelada se informa marcada como pesimista y no vinculante', () => {
  const aviso = coverBudgetMessage(coverManifestBudget({
    manifestBytes: PROVEN_MANIFEST_BYTES, entries: PROVEN_MANIFEST_ENTRIES,
  }));
  assert.match(aviso, /pesimista y no vinculante/);
  assert.match(aviso, /un Worker real completó el sync igual/);
  assert.match(aviso, /actions\/runs\/34521572816/,
    'la afirmación tiene que venir con la corrida que la respalda');
});

test('crecer por encima de lo probado avisa, y dice qué hacer', () => {
  const budget = coverManifestBudget({
    manifestBytes: Math.round(PROVEN_MANIFEST_BYTES * 1.3), entries: 105000,
  });
  assert.equal(budget.level, 'warn');
  const aviso = coverBudgetMessage(budget);
  assert.match(aviso, /AVISO/);
  assert.match(aviso, /volver a probar/, 'lo que corresponde es probar, no suponer');
});

test('irse muy lejos de lo probado es crítico y ofrece las dos salidas', () => {
  const budget = coverManifestBudget({
    manifestBytes: Math.round(PROVEN_MANIFEST_BYTES * 1.7), entries: 137000,
  });
  assert.equal(budget.level, 'critical');
  const aviso = coverBudgetMessage(budget);
  assert.match(aviso, /CRÍTICO/);
  // Las dos salidas reales: probar y subir la línea de base, o migrar.
  assert.match(aviso, /PROVEN_MANIFEST_BYTES/);
  assert.match(aviso, /shards/);
  assert.match(aviso, /1102/);
});

test('los umbrales se activan exactamente donde dicen', () => {
  // `Math.round` puede caer un byte por debajo del factor exacto, así que el
  // borde de arriba se toma con un byte de más: lo que se prueba es el umbral,
  // no la aritmética del redondeo.
  const nivelDe = factor => coverManifestBudget({
    manifestBytes: Math.ceil(PROVEN_MANIFEST_BYTES * factor), entries: 90000,
  }).level;
  assert.equal(nivelDe(WARN_OVER_PROVEN - 0.01), 'ok');
  assert.equal(nivelDe(WARN_OVER_PROVEN), 'warn');
  assert.equal(nivelDe(CRITICAL_OVER_PROVEN - 0.01), 'warn');
  assert.equal(nivelDe(CRITICAL_OVER_PROVEN), 'critical');
});

test('el nivel es un hecho sobre bytes: no depende de que haya medición', () => {
  // Comparar bytes contra bytes se puede afirmar siempre. Por eso este nivel
  // sí puede poner el CI en rojo, a diferencia del pico modelado.
  const conMedida = coverManifestBudget({
    manifestBytes: PROVEN_MANIFEST_BYTES, entries: PROVEN_MANIFEST_ENTRIES, measured: MEDIDO,
  });
  const sinMedida = coverManifestBudget({
    manifestBytes: PROVEN_MANIFEST_BYTES, entries: PROVEN_MANIFEST_ENTRIES,
  });
  assert.equal(conMedida.level, sinMedida.level);
  assert.equal(conMedida.enforceable, true);
  assert.equal(sinMedida.enforceable, true);
  // Pero la cota modelada sí cambia: con medición usa el número real.
  assert.equal(conMedida.source, 'measured');
  assert.equal(sinMedida.source, 'modelled');
  assert.equal(conMedida.breakdown_mb.graph, MEDIDO.graph_mb);
  assert.notEqual(sinMedida.breakdown_mb.graph, MEDIDO.graph_mb);
});

test('una medición inválida no se toma por buena', () => {
  for (const medida of [null, {}, { graph_mb: 0 }, { graph_mb: -5 },
    { graph_mb: 'mucho' }, { graph_mb: NaN }]) {
    const budget = coverManifestBudget({
      manifestBytes: PROVEN_MANIFEST_BYTES, entries: PROVEN_MANIFEST_ENTRIES, measured: medida,
    });
    assert.equal(budget.source, 'modelled', `${JSON.stringify(medida)} no es una medición`);
  }
});

test('el desglose suma exactamente la cota modelada', () => {
  for (const medida of [null, MEDIDO]) {
    const budget = coverManifestBudget({
      manifestBytes: PROVEN_MANIFEST_BYTES, entries: PROVEN_MANIFEST_ENTRIES, measured: medida,
    });
    const suma = Object.values(budget.breakdown_mb).reduce((total, parte) => total + parte, 0);
    assert.ok(Math.abs(suma - budget.estimated_peak_mb) < 0.2,
      `el desglose suma ${suma} y la cota dice ${budget.estimated_peak_mb}`);
  }
});

test('la copia de entries escala con las entradas, no con los bytes', () => {
  // Copia claves, no contenido. Tenerlo "por MB de JSON" era un error de
  // dimensión: en manifests con entradas grandes daba de más.
  const chicas = coverManifestBudget({ manifestBytes: 20 * MB, entries: 100000 });
  const grandes = coverManifestBudget({ manifestBytes: 100 * MB, entries: 100000 });
  assert.equal(chicas.breakdown_mb.entries_copy, grandes.breakdown_mb.entries_copy);
  assert.ok(Math.abs(chicas.breakdown_mb.entries_copy
    - (100000 * ENTRIES_COPY_BYTES_PER_ENTRY) / MB) < 0.11);
});

test('la cota modelada crece linealmente con el manifest', () => {
  // Si algún día alguien mete un término cuadrático sin querer, esto lo agarra.
  const uno = coverManifestBudget({ manifestBytes: 10 * MB, entries: 50000 });
  const dos = coverManifestBudget({ manifestBytes: 20 * MB, entries: 50000 });
  assert.ok(Math.abs(dos.breakdown_mb.graph - 2 * uno.breakdown_mb.graph) < 0.2);
  assert.equal(dos.breakdown_mb.entries_copy, uno.breakdown_mb.entries_copy);
  const fijo = SHARD_BUFFERS_MB + WORKER_BASELINE_MB + uno.breakdown_mb.entries_copy;
  assert.ok(Math.abs((dos.estimated_peak_mb - fijo) - 2 * (uno.estimated_peak_mb - fijo)) < 0.2);
});

test('una medida inválida rompe fuerte en vez de inventar un margen', () => {
  // Un `Number(null)` que se cuela como 0 daría "0% usado" y taparía justo lo
  // que este módulo existe para no tapar.
  for (const bytes of [0, -1, null, undefined, NaN, 'muchos', Infinity]) {
    assert.throws(() => coverManifestBudget({ manifestBytes: bytes }),
      /cover-budget-invalid-manifest-bytes/,
      `${String(bytes)} no puede pasar como un tamaño válido`);
  }
});

test('sin cantidad de entradas informa igual, pero no inventa nada', () => {
  const budget = coverManifestBudget({ manifestBytes: PROVEN_MANIFEST_BYTES });
  assert.equal(budget.entries, null);
  assert.equal(budget.bytes_per_entry, null);
  assert.equal(budget.level, 'ok', 'el nivel depende de los bytes, no de las entradas');
});

test('el modelo sigue anclado a lo que dice Cloudflare', () => {
  // Si alguien cambia estas constantes sin medir, el resto de los tests no lo
  // agarra: la cota modelada no decide nada. Que al menos no se muevan solas.
  assert.equal(ISOLATE_LIMIT_MB, 128);
  assert.ok(GRAPH_PER_JSON_MB > 1 && GRAPH_PER_JSON_MB < 2,
    'parseado midió 1,25x; construido 2,2x. Fuera de ese rango algo se midió mal');
});
