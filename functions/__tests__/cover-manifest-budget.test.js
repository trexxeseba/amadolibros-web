import test from 'node:test';
import assert from 'node:assert/strict';

import {
  coverManifestBudget,
  coverBudgetMessage,
  ISOLATE_LIMIT_MB,
  GRAPH_PER_JSON_MB,
  ENTRIES_COPY_PER_JSON_MB,
  SHARD_BUFFERS_MB,
  WORKER_BASELINE_MB,
  WARN_PERCENT,
  CRITICAL_PERCENT,
} from '../_shared/cover-manifest-budget.js';

const MB = 1024 * 1024;

test('el manifest de producción de hoy ya está en zona de aviso', () => {
  // 31,6 MB / 80.863 entradas, medido el 2026-09-10. Este test es el que le
  // pone número a "está al límite": no es una impresión, son 73 de 128 MB.
  const budget = coverManifestBudget({ manifestBytes: 31.6 * MB, entries: 80863 });
  assert.equal(budget.level, 'warn');
  assert.ok(budget.used_percent > 70 && budget.used_percent < 80,
    `esperaba entre 70% y 80%, dio ${budget.used_percent}%`);
  assert.ok(budget.growth_left_x > 1.3 && budget.growth_left_x < 1.7,
    `el margen de crecimiento dio ${budget.growth_left_x}x`);
  assert.ok(budget.entries_at_limit > 110000 && budget.entries_at_limit < 130000,
    `el techo de entradas dio ${budget.entries_at_limit}`);
});

test('el desglose suma exactamente el pico estimado', () => {
  // Si el desglose no suma, el informe miente sobre de dónde viene el número.
  const budget = coverManifestBudget({ manifestBytes: 31.6 * MB, entries: 80863 });
  const suma = Object.values(budget.breakdown_mb).reduce((total, parte) => total + parte, 0);
  assert.ok(Math.abs(suma - budget.estimated_peak_mb) < 0.2,
    `el desglose suma ${suma} y el pico dice ${budget.estimated_peak_mb}`);
});

test('los tres niveles se activan donde dicen que se activan', () => {
  const nivelDe = mb => coverManifestBudget({ manifestBytes: mb * MB }).level;
  // El MB de JSON en el que se cruza cada umbral, según el propio modelo.
  const porMb = GRAPH_PER_JSON_MB + ENTRIES_COPY_PER_JSON_MB;
  const mbEn = porcentaje =>
    ((ISOLATE_LIMIT_MB * porcentaje / 100) - SHARD_BUFFERS_MB - WORKER_BASELINE_MB) / porMb;

  assert.equal(nivelDe(mbEn(WARN_PERCENT) - 1), 'ok');
  assert.equal(nivelDe(mbEn(WARN_PERCENT) + 0.5), 'warn');
  assert.equal(nivelDe(mbEn(CRITICAL_PERCENT) - 1), 'warn');
  assert.equal(nivelDe(mbEn(CRITICAL_PERCENT) + 0.5), 'critical');
});

test('un manifest chico no dispara nada', () => {
  const budget = coverManifestBudget({ manifestBytes: 5 * MB, entries: 12000 });
  assert.equal(budget.level, 'ok');
  assert.ok(budget.used_percent < WARN_PERCENT);
  assert.ok(budget.growth_left_x > 5);
});

test('un manifest que ya no entra se marca crítico y lo dice', () => {
  const budget = coverManifestBudget({ manifestBytes: 60 * MB, entries: 150000 });
  assert.equal(budget.level, 'critical');
  assert.ok(budget.estimated_peak_mb > ISOLATE_LIMIT_MB,
    'si el pico supera el isolate, es exactamente el 1102 que ya nos pasó');
  assert.ok(budget.growth_left_x < 1, 'ya se pasó del techo, no le queda crecimiento');
  assert.match(coverBudgetMessage(budget), /CRÍTICO/);
  assert.match(coverBudgetMessage(budget), /1102/);
});

test('el mensaje dice qué hacer, no sólo cuánto queda', () => {
  const aviso = coverBudgetMessage(coverManifestBudget({ manifestBytes: 31.6 * MB, entries: 80863 }));
  // Un porcentaje suelto en un JSON de CI no lo lee nadie hasta que ya es tarde.
  assert.match(aviso, /AVISO/);
  assert.match(aviso, /shards/, 'tiene que nombrar la migración que corresponde');
  assert.match(aviso, /31\.6 MB/);
  assert.match(aviso, /80863 entradas/);

  const sano = coverBudgetMessage(coverManifestBudget({ manifestBytes: 5 * MB }));
  assert.doesNotMatch(sano, /AVISO|CRÍTICO/);
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
  const budget = coverManifestBudget({ manifestBytes: 31.6 * MB });
  assert.equal(budget.entries, null);
  assert.equal(budget.entries_at_limit, null);
  assert.ok(budget.used_percent > 0, 'el porcentaje no depende de las entradas');
});

test('el modelo crece linealmente con el manifest', () => {
  // Si algún día alguien mete un término cuadrático sin querer, esto lo agarra.
  const uno = coverManifestBudget({ manifestBytes: 10 * MB });
  const dos = coverManifestBudget({ manifestBytes: 20 * MB });
  const fijo = SHARD_BUFFERS_MB + WORKER_BASELINE_MB;
  assert.ok(Math.abs((dos.estimated_peak_mb - fijo) - 2 * (uno.estimated_peak_mb - fijo)) < 0.2);
});
