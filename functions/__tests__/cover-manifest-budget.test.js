import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coverManifestBudget,
  coverBudgetMessage,
  ISOLATE_LIMIT_MB,
  GRAPH_PER_JSON_MB,
  ENTRIES_COPY_BYTES_PER_ENTRY,
  ENTRIES_COPY_PER_JSON_MB,
  SHARD_BUFFERS_MB,
  WORKER_BASELINE_MB,
  WARN_PERCENT,
  CRITICAL_PERCENT,
} from '../_shared/cover-manifest-budget.js';

const MB = 1024 * 1024;

// El manifest real, tomado de la corrida de CI del 2026-09-10, y su medición
// real hecha con JSON.parse (que es lo que hace el Worker).
const REAL_BYTES = 108774952;
const REAL_ENTRIES = 80871;
const REAL_MEDIDO = { graph_mb: 133.8, entries_copy_mb: 2.4, graph_per_json: 1.25 };

test('con el manifest real medido, el escritor YA se pasa del isolate', () => {
  // Éste es el hallazgo, y el test existe para que no se pierda: el cron de
  // portadas necesita más memoria de la que tiene un isolate. Funciona igual
  // porque Cloudflare deja terminar el pedido en vuelo y recicla el isolate,
  // pero eso es exactamente lo que se rompió con el catálogo pausado (1102).
  const budget = coverManifestBudget({
    manifestBytes: REAL_BYTES, entries: REAL_ENTRIES, measured: REAL_MEDIDO,
  });
  assert.equal(budget.level, 'critical');
  assert.equal(budget.over_limit, true);
  assert.ok(budget.estimated_peak_mb > ISOLATE_LIMIT_MB,
    `el pico dio ${budget.estimated_peak_mb} MB y el isolate son ${ISOLATE_LIMIT_MB}`);
  assert.equal(budget.source, 'measured');
  assert.equal(budget.enforceable, true);
});

test('el mensaje de crítico no dice "está por morir" cuando el sitio anda', () => {
  // Un guardián que se contradice con la realidad la primera vez que habla
  // deja de ser creíble justo el día que tiene razón.
  const aviso = coverBudgetMessage(coverManifestBudget({
    manifestBytes: REAL_BYTES, entries: REAL_ENTRIES, measured: REAL_MEDIDO,
  }));
  assert.match(aviso, /YA se pasa del isolate/);
  assert.match(aviso, /recicla el isolate/, 'tiene que explicar por qué sigue andando');
  assert.match(aviso, /1102/);
  assert.match(aviso, /shards/, 'tiene que nombrar la migración que corresponde');
  assert.doesNotMatch(aviso, /está por morir/);
});

test('sin medición nunca se puede poner el CI en rojo', () => {
  // El modelo solo, contra el manifest real, se equivocó por 76% la primera
  // vez. Puede informar, pero no puede decidir.
  const budget = coverManifestBudget({ manifestBytes: REAL_BYTES, entries: REAL_ENTRIES });
  assert.equal(budget.source, 'modelled');
  assert.equal(budget.enforceable, false);
  assert.match(coverBudgetMessage(budget), /SIN MEDIR/);
  assert.match(coverBudgetMessage(budget), /cover-manifest-measure/,
    'tiene que decir cómo medirlo, no sólo que falta');
});

test('la medición manda sobre el modelo', () => {
  const conMedida = coverManifestBudget({
    manifestBytes: REAL_BYTES, entries: REAL_ENTRIES, measured: REAL_MEDIDO,
  });
  assert.equal(conMedida.breakdown_mb.graph, REAL_MEDIDO.graph_mb);
  assert.equal(conMedida.breakdown_mb.entries_copy, REAL_MEDIDO.entries_copy_mb);
  // Y el modelo queda a la vista para poder comparar cuánto se apartó.
  assert.notEqual(conMedida.modelled_graph_mb, conMedida.breakdown_mb.graph);
  assert.equal(conMedida.measured_graph_per_json, 1.25);
});

test('una medición inválida no se toma por buena', () => {
  for (const medida of [null, {}, { graph_mb: 0 }, { graph_mb: -5 },
    { graph_mb: 'mucho' }, { graph_mb: NaN }]) {
    const budget = coverManifestBudget({
      manifestBytes: REAL_BYTES, entries: REAL_ENTRIES, measured: medida,
    });
    assert.equal(budget.source, 'modelled', `${JSON.stringify(medida)} no es una medición`);
    assert.equal(budget.enforceable, false);
  }
});

test('el desglose suma exactamente el pico estimado', () => {
  for (const medida of [null, REAL_MEDIDO]) {
    const budget = coverManifestBudget({
      manifestBytes: REAL_BYTES, entries: REAL_ENTRIES, measured: medida,
    });
    const suma = Object.values(budget.breakdown_mb).reduce((total, parte) => total + parte, 0);
    assert.ok(Math.abs(suma - budget.estimated_peak_mb) < 0.2,
      `el desglose suma ${suma} y el pico dice ${budget.estimated_peak_mb}`);
  }
});

test('la copia de entries escala con las entradas, no con los bytes', () => {
  // Copia claves, no contenido. Tenerlo en "por MB de JSON" era un error de
  // dimensión: en manifests con entradas grandes daba de más.
  const chicas = coverManifestBudget({ manifestBytes: 20 * MB, entries: 100000 });
  const grandes = coverManifestBudget({ manifestBytes: 100 * MB, entries: 100000 });
  assert.equal(chicas.breakdown_mb.entries_copy, grandes.breakdown_mb.entries_copy);

  const esperado = (100000 * ENTRIES_COPY_BYTES_PER_ENTRY) / MB;
  assert.ok(Math.abs(chicas.breakdown_mb.entries_copy - esperado) < 0.11);
});

test('los tres niveles se activan donde dicen que se activan', () => {
  // Sin `entries` la copia cae al respaldo por MB, así que el umbral se
  // calcula con los dos términos que realmente se usan en ese caso.
  const nivelDe = mb => coverManifestBudget({ manifestBytes: mb * MB }).level;
  const porMb = GRAPH_PER_JSON_MB + ENTRIES_COPY_PER_JSON_MB;
  const mbEn = porcentaje =>
    ((ISOLATE_LIMIT_MB * porcentaje / 100) - SHARD_BUFFERS_MB - WORKER_BASELINE_MB) / porMb;

  assert.equal(nivelDe(mbEn(WARN_PERCENT) - 1), 'ok');
  assert.equal(nivelDe(mbEn(WARN_PERCENT) + 0.5), 'warn');
  assert.equal(nivelDe(mbEn(CRITICAL_PERCENT) - 1), 'warn');
  assert.equal(nivelDe(mbEn(CRITICAL_PERCENT) + 0.5), 'critical');
});

test('over_limit sólo es cierto cuando el pico pasa el isolate de verdad', () => {
  // 80% ya es crítico, pero crítico no es lo mismo que pasado.
  // Con medición, para que el mensaje sea el de crítico y no el de "sin medir".
  const apretado = coverManifestBudget({ manifestBytes: 78 * MB, entries: 80000,
    measured: { graph_mb: 100, entries_copy_mb: 4.3, graph_per_json: 1.28 } });
  assert.equal(apretado.level, 'critical');
  assert.equal(apretado.over_limit, false, '124 MB de 128 es crítico pero todavía entra');
  assert.match(coverBudgetMessage(apretado), /casi no le queda margen/);
  assert.doesNotMatch(coverBudgetMessage(apretado), /YA se pasa/);

  const pasado = coverManifestBudget({ manifestBytes: 100 * MB, entries: 80000,
    measured: { graph_mb: 130, entries_copy_mb: 4.3, graph_per_json: 1.3 } });
  assert.equal(pasado.over_limit, true);
  assert.match(coverBudgetMessage(pasado), /YA se pasa del isolate/);
});

test('un manifest chico no dispara nada', () => {
  const budget = coverManifestBudget({ manifestBytes: 5 * MB, entries: 12000 });
  assert.equal(budget.level, 'ok');
  assert.equal(budget.over_limit, false);
  assert.ok(budget.used_percent < WARN_PERCENT);
  assert.ok(budget.growth_left_x > 5);
  assert.doesNotMatch(coverBudgetMessage(budget), /CRÍTICO/);
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

test('sin cantidad de entradas informa igual, pero no inventa el techo', () => {
  const budget = coverManifestBudget({ manifestBytes: REAL_BYTES });
  assert.equal(budget.entries, null);
  assert.equal(budget.entries_at_limit, null);
  assert.equal(budget.bytes_per_entry, null);
  assert.ok(budget.used_percent > 0, 'el porcentaje no depende de las entradas');
});

test('el modelo crece linealmente con el manifest', () => {
  // Si algún día alguien mete un término cuadrático sin querer, esto lo agarra.
  // Con la misma cantidad de entradas, la copia es constante y sólo el grafo
  // depende de los bytes: duplicar el JSON tiene que duplicar el grafo.
  const uno = coverManifestBudget({ manifestBytes: 10 * MB, entries: 50000 });
  const dos = coverManifestBudget({ manifestBytes: 20 * MB, entries: 50000 });
  assert.ok(Math.abs(dos.breakdown_mb.graph - 2 * uno.breakdown_mb.graph) < 0.2);
  assert.equal(dos.breakdown_mb.entries_copy, uno.breakdown_mb.entries_copy);

  const fijo = SHARD_BUFFERS_MB + WORKER_BASELINE_MB + uno.breakdown_mb.entries_copy;
  assert.ok(Math.abs((dos.estimated_peak_mb - fijo) - 2 * (uno.estimated_peak_mb - fijo)) < 0.2);
});
