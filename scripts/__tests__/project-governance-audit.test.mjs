import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGovernanceReport,
  classifyPullRequest,
  findCriticalCollisions,
  summarizeChecks,
} from '../ops/project-governance-audit.mjs';

const now = new Date('2026-08-24T12:00:00Z');

test('clasifica CI rojo antes que la antigüedad del Draft', () => {
  const row = classifyPullRequest({
    number: 1,
    title: 'Falla',
    draft: true,
    updated_at: '2026-08-14T12:00:00Z',
    checks_state: 'failure',
    owner: 'claude',
    head: { ref: 'agent/falla-1' },
  }, { now });
  assert.equal(row.recommendation, 'fix_ci');
  assert.ok(row.reasons.includes('CI rojo'));
  assert.equal(row.idle_hours, 240);
});

test('detecta Draft sin próxima acción a las 72 horas', () => {
  const row = classifyPullRequest({
    number: 2,
    title: 'Pendiente',
    draft: true,
    updated_at: '2026-08-21T12:00:00Z',
    checks_state: 'success',
    owner: '',
    head: { ref: 'agent/pendiente-1' },
  }, { now });
  assert.equal(row.recommendation, 'assign_next_action');
  assert.ok(row.reasons.includes('sin responsable declarado'));
});

test('detecta colisiones sólo en archivos críticos', () => {
  const collisions = findCriticalCollisions([
    { number: 10, files: ['functions/catalogo.js', 'README.md'] },
    { number: 11, files: ['functions/catalogo.js'] },
    { number: 12, files: ['README.md'] },
  ]);
  assert.deepEqual(collisions, [{ file: 'functions/catalogo.js', pull_requests: [10, 11] }]);
});

test('separa ramas sin PR y nunca marca main', () => {
  const report = buildGovernanceReport({
    pulls: [{
      number: 20,
      title: 'Activo',
      draft: false,
      updated_at: '2026-08-24T11:00:00Z',
      checks_state: 'success',
      owner: 'chatgpt',
      head: { ref: 'agent/activo-1' },
      files: [],
    }],
    branches: [{ name: 'main' }, { name: 'agent/activo-1' }, { name: 'agent/huerfana-1' }],
    now,
  });
  assert.deepEqual(report.branches_without_pr, ['agent/huerfana-1']);
  assert.equal(report.metrics.open_prs, 1);
});

test('resume Check Runs sin confundir skipped con error', () => {
  assert.equal(summarizeChecks([]), 'unknown');
  assert.equal(summarizeChecks([{ status: 'queued', conclusion: null }]), 'pending');
  assert.equal(summarizeChecks([{ status: 'completed', conclusion: 'failure' }]), 'failure');
  assert.equal(summarizeChecks([
    { status: 'completed', conclusion: 'success' },
    { status: 'completed', conclusion: 'skipped' },
  ]), 'success');
});
