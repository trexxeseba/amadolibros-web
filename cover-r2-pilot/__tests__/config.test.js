import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wrangler = readFileSync('cover-r2-pilot/wrangler.toml', 'utf8');
const workflow = readFileSync('.github/workflows/deploy-cover-r2-pilot-preview.yml', 'utf8');
const validate = readFileSync('scripts/validate-ci.sh', 'utf8');

test('wrangler usa sólo el bucket Preview y no declara cron ni routes', () => {
  assert.match(wrangler, /binding\s*=\s*"COVER_R2"/);
  assert.match(wrangler, /bucket_name\s*=\s*"amadolibros-images-preview"/);
  assert.doesNotMatch(wrangler, /amadolibros-catalog/);
  assert.doesNotMatch(wrangler, /\[triggers\]|crons\s*=|routes?\s*=/);
});

test('deploy del PR queda bloqueado a la rama y repo exactos del piloto', () => {
  assert.match(workflow, /pull_request:\n\s+types: \[opened, synchronize, reopened\]/);
  assert.match(workflow, /branches:\n\s+- main/);
  assert.match(workflow, /github\.head_ref != 'agent\/cover-r2-pilot-20'/);
  assert.match(workflow, /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/);
  assert.doesNotMatch(workflow, /workflow_dispatch:|\npush:/);
  assert.match(workflow, /COVER_PILOT_SECRET/);
  assert.match(workflow, /environment:\n\s+name: preview/);
  assert.match(workflow, /r2 bucket create amadolibros-images-preview/);
  assert.match(workflow, /openssl rand -hex 32/);
  assert.match(workflow, /attempted!==20\|\|r\.failed!==0/);
  assert.match(workflow, /issues: write/);
  assert.match(workflow, /COVER-R2-PILOT —.*20\/20 CONFIRMADO/);
  assert.match(workflow, /issue_number: 99/);
});

test('CI compartido incluye sintaxis y tests del piloto', () => {
  assert.match(validate, /find functions scripts worker-sync cover-r2-pilot/);
  assert.match(validate, /node --test cover-r2-pilot\/__tests__\/\*\.test\.js/);
});
