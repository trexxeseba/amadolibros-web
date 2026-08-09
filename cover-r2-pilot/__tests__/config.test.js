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

test('deploy es manual y queda bloqueado a la rama exacta del piloto', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /refs\/heads\/agent\/cover-r2-pilot-20/);
  assert.doesNotMatch(workflow, /^\s*push:/m);
  assert.doesNotMatch(workflow, /refs\/heads\/main|branches:\s*\[?main/);
  assert.match(workflow, /COVER_PILOT_SECRET/);
  assert.match(workflow, /environment:\n\s+name: preview/);
});

test('CI compartido incluye sintaxis y tests del piloto', () => {
  assert.match(validate, /find functions scripts worker-sync cover-r2-pilot/);
  assert.match(validate, /node --test cover-r2-pilot\/__tests__\/\*\.test\.js/);
});
