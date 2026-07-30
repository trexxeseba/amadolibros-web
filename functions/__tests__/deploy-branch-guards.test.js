import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const pagesWorkflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const workerWorkflow = readFileSync(
  '.github/workflows/deploy-worker-sync.yml',
  'utf8',
);

const manualMainGuard =
  "github.event_name == 'workflow_dispatch' && github.ref != 'refs/heads/main'";

test('deploy.yml bloquea ejecuciones manuales fuera de main antes de validar', () => {
  assert.match(pagesWorkflow, /^  guard:\n/m);
  assert.match(pagesWorkflow, new RegExp(`if: ${manualMainGuard}`));
  assert.match(pagesWorkflow, /^    needs: guard$/m);
});

test('deploy-worker-sync.yml bloquea ejecuciones manuales fuera de main', () => {
  assert.match(workerWorkflow, new RegExp(`if: ${manualMainGuard}`));
});

test('deploy-worker-sync.yml usa el environment production', () => {
  assert.match(
    workerWorkflow,
    /^    environment:\n      name: production$/m,
  );
});
