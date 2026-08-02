import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { run } from '../run.js';

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'categorize-test-'));
}

function writeSnapshot(dir, items) {
  const snapshotPath = path.join(dir, 'snapshot.json');
  writeFileSync(snapshotPath, JSON.stringify({
    fetched_at: '2026-08-02T00:00:00.000Z',
    items,
  }));
  return snapshotPath;
}

function writeCorrections(dir, corrections) {
  const p = path.join(dir, 'corrections.json');
  writeFileSync(p, JSON.stringify(corrections));
  return p;
}

test('consolida por MLU: un id repetido en el snapshot produce un único resultado', () => {
  const dir = makeTempDir();
  try {
    const snapshotPath = writeSnapshot(dir, [
      { id: 'MLU1', title: 'Historia Del Uruguay', author: 'Ian Kershaw', status: 'active' },
      { id: 'MLU1', title: 'Duplicado accidental del mismo id', author: '', status: 'active' },
    ]);
    const correctionsPath = writeCorrections(dir, []);
    const outputPath = path.join(dir, 'out.json');
    const { results } = run({ snapshotPath, outputPath, correctionsPath });
    assert.equal(results.length, 1);
    assert.equal(results[0].mlu, 'MLU1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('no modifica el snapshot de entrada (cero modificación de datos originales)', () => {
  const dir = makeTempDir();
  try {
    const items = [{ id: 'MLU1', title: 'Tarot', author: '', status: 'active' }];
    const snapshotPath = writeSnapshot(dir, items);
    const before = readFileSync(snapshotPath, 'utf8');
    const correctionsPath = writeCorrections(dir, []);
    const outputPath = path.join(dir, 'out.json');
    run({ snapshotPath, outputPath, correctionsPath });
    const after = readFileSync(snapshotPath, 'utf8');
    assert.equal(before, after);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ejecución reproducible: misma entrada produce el mismo resultado', () => {
  const dir = makeTempDir();
  try {
    const items = [
      { id: 'MLU1', title: 'Tarot Egipcio', author: '', status: 'active' },
      { id: 'MLU2', title: 'Historia Del Uruguay', author: 'Ian Kershaw', status: 'active' },
      { id: 'MLU3', title: 'xkzq blorp', author: '', status: 'active' },
    ];
    const snapshotPath = writeSnapshot(dir, items);
    const correctionsPath = writeCorrections(dir, []);
    const out1 = path.join(dir, 'out1.json');
    const out2 = path.join(dir, 'out2.json');
    const r1 = run({ snapshotPath, outputPath: out1, correctionsPath });
    const r2 = run({ snapshotPath, outputPath: out2, correctionsPath });
    assert.deepEqual(r1.results, r2.results);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reanudación: una segunda corrida con la misma versión reusa resultados sin reclasificar', () => {
  const dir = makeTempDir();
  try {
    const items = [
      { id: 'MLU1', title: 'Tarot Egipcio', author: '', status: 'active' },
      { id: 'MLU2', title: 'Historia Del Uruguay', author: 'Ian Kershaw', status: 'active' },
    ];
    const snapshotPath = writeSnapshot(dir, items);
    const correctionsPath = writeCorrections(dir, []);
    const outputPath = path.join(dir, 'out.json');
    const first = run({ snapshotPath, outputPath, correctionsPath });
    assert.equal(first.summary.reclassified_this_run, 2);
    assert.equal(first.summary.reused_from_previous_run, 0);

    const second = run({ snapshotPath, outputPath, correctionsPath });
    assert.equal(second.summary.reclassified_this_run, 0);
    assert.equal(second.summary.reused_from_previous_run, 2);
    assert.deepEqual(first.results, second.results);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('una corrección manual persiste y gana incluso después de una corrida previa sin ella', () => {
  const dir = makeTempDir();
  try {
    const items = [{ id: 'MLU1', title: 'Cualquier título', author: 'Judith Butler', status: 'active' }];
    const snapshotPath = writeSnapshot(dir, items);
    const outputPath = path.join(dir, 'out.json');

    const noCorrectionPath = writeCorrections(dir, []);
    const first = run({ snapshotPath, outputPath, correctionsPath: noCorrectionPath });
    assert.equal(first.results[0].primaryCategoryId, 'filosofia-ciencias-sociales');
    assert.equal(first.results[0].method, 'rule');

    const withCorrectionPath = writeCorrections(dir, [
      { mlu: 'MLU1', type: 'book', primaryCategoryId: 'historia', subcategoryId: null, secondaryCategoryIds: [], tags: [], note: 'corrección manual de prueba' },
    ]);
    const second = run({ snapshotPath, outputPath, correctionsPath: withCorrectionPath });
    assert.equal(second.results[0].primaryCategoryId, 'historia');
    assert.equal(second.results[0].method, 'manual');
    assert.equal(second.summary.manual_corrections_applied, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sin errores de validación en una corrida normal', () => {
  const dir = makeTempDir();
  try {
    const items = [
      { id: 'MLU1', title: 'Tarot Egipcio', author: '', status: 'active' },
      { id: 'MLU2', title: 'Candelabro Bronce Antiguo Decorativo', author: '', publisher: 'Genérica', status: 'paused' },
      { id: 'MLU3', title: 'xkzq blorp', author: '', status: 'active' },
    ];
    const snapshotPath = writeSnapshot(dir, items);
    const correctionsPath = writeCorrections(dir, []);
    const outputPath = path.join(dir, 'out.json');
    const { errors } = run({ snapshotPath, outputPath, correctionsPath });
    assert.deepEqual(errors, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CF-CATEGORÍAS-2C: todos los activos quedan incluidos, ninguno con primaryCategoryId null', () => {
  const dir = makeTempDir();
  try {
    const items = [
      { id: 'MLU1', title: 'Tarot Egipcio', author: '', status: 'active' },
      { id: 'MLU2', title: 'Candelabro Bronce Antiguo Decorativo', author: '', publisher: 'Genérica', status: 'active' },
      { id: 'MLU3', title: 'xkzq blorp completamente sin señal', author: '', publisher: '', isbn: '', status: 'active' },
      { id: 'MLU4', title: 'Revista Patrones 421', author: '', isbn: '', status: 'active' },
    ];
    const snapshotPath = writeSnapshot(dir, items);
    const correctionsPath = writeCorrections(dir, []);
    const outputPath = path.join(dir, 'out.json');
    const { results } = run({ snapshotPath, outputPath, correctionsPath });
    assert.equal(results.length, items.length);
    for (const r of results) {
      assert.notEqual(r.primaryCategoryId, null, `${r.mlu} quedó sin categoría`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sin MLU duplicados en la salida', () => {
  const dir = makeTempDir();
  try {
    const items = [
      { id: 'MLU1', title: 'Tarot Egipcio', author: '', status: 'active' },
      { id: 'MLU2', title: 'Historia Del Uruguay', author: '', status: 'active' },
      { id: 'MLU1', title: 'Duplicado accidental', author: '', status: 'active' },
    ];
    const snapshotPath = writeSnapshot(dir, items);
    const correctionsPath = writeCorrections(dir, []);
    const outputPath = path.join(dir, 'out.json');
    const { results } = run({ snapshotPath, outputPath, correctionsPath });
    const ids = results.map(r => r.mlu);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CF-CATEGORÍAS-2D: las pausadas también quedan clasificadas, sin categoría nula', () => {
  const dir = makeTempDir();
  try {
    const items = [
      { id: 'MLU1', title: 'Historia Del Uruguay', author: 'Ian Kershaw', status: 'active' },
      { id: 'MLU2', title: 'Tarot Egipcio', author: '', status: 'paused' },
      { id: 'MLU3', title: 'xkzq blorp sin señal alguna', author: '', publisher: '', isbn: '', status: 'paused' },
    ];
    const snapshotPath = writeSnapshot(dir, items);
    const correctionsPath = writeCorrections(dir, []);
    const outputPath = path.join(dir, 'out.json');
    const { results } = run({ snapshotPath, outputPath, correctionsPath });
    const paused = results.filter(r => r.status === 'paused');
    assert.equal(paused.length, 2);
    for (const r of paused) assert.notEqual(r.primaryCategoryId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CF-CATEGORÍAS-2D: la categoría de un producto no depende de su status (se conserva al reactivarse)', () => {
  const dir = makeTempDir();
  try {
    const active = writeSnapshot(dir, [
      { id: 'MLU1', title: 'Tarot Egipcio Oráculo', author: '', status: 'active' },
    ]);
    const paused = writeSnapshot(dir, [
      { id: 'MLU1', title: 'Tarot Egipcio Oráculo', author: '', status: 'paused' },
    ]);
    const correctionsPath = writeCorrections(dir, []);
    const rActive = run({ snapshotPath: active, outputPath: path.join(dir, 'out-active.json'), correctionsPath });
    const rPaused = run({ snapshotPath: paused, outputPath: path.join(dir, 'out-paused.json'), correctionsPath });
    assert.equal(rActive.results[0].primaryCategoryId, rPaused.results[0].primaryCategoryId);
    assert.equal(rActive.results[0].subcategoryId, rPaused.results[0].subcategoryId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lanza un error claro si no existe el snapshot (no intenta llamar a producción)', () => {
  const dir = makeTempDir();
  try {
    assert.throws(
      () => run({ snapshotPath: path.join(dir, 'no-existe.json'), outputPath: path.join(dir, 'out.json'), correctionsPath: path.join(dir, 'c.json') }),
      /No existe/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
