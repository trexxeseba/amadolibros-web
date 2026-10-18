import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../../.github/workflows/card-generation-pilot-preview.yml', import.meta.url), 'utf8');
const toml = readFileSync(new URL('../../worker-sync/card-generation-preview.wrangler.toml', import.meta.url), 'utf8');
const runBlocks = [...workflow.matchAll(/^\s+run: \|\n((?:\s{10,}.*\n|\n)+)/gm)].map(m => m[1]);

test('pilot workflow is manual only and requires the written confirmation', () => {
  const triggers = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(triggers, /workflow_dispatch:/);
  assert.doesNotMatch(triggers, /pull_request|push:|schedule:|workflow_run/);
  assert.match(workflow, /PREVIEW-ONLY-32-ATTEMPTS/);
  assert.match(workflow, /needs: guard/g);
  assert.match(workflow, /permissions:\n  contents: read\n  actions: read/);
});

test('no user input is interpolated inside scripts (inputs go through env) and secrets never reach logs', () => {
  assert.ok(runBlocks.length >= 6, 'run blocks found');
  for (const block of runBlocks) assert.doesNotMatch(block, /\$\{\{/, 'no expression inside a run script');
  assert.match(workflow, /add-mask::\$PILOT_TOKEN/g);
  assert.doesNotMatch(workflow, /echo .*CLOUDFLARE_API_TOKEN/);
});

test('the workflow only deploys the isolated Preview Worker and always cleans it up; nothing production-facing', () => {
  assert.match(workflow, /--config worker-sync\/card-generation-preview\.wrangler\.toml/g);
  for (const line of workflow.split('\n').filter(l => /deploy-cover-preview\.sh|wrangler@/.test(l) && !l.trim().startsWith('#')))
    assert.match(line, /--config worker-sync\/card-generation-preview\.wrangler\.toml/, `every wrangler call uses the Preview config: ${line.trim()}`);
  assert.doesNotMatch(workflow, /pages deploy|--env production|r2 object|aws s3|wrangler r2|wrangler@\S+ (?:deploy|publish)/);
  assert.equal((workflow.match(/trap cleanup EXIT/g) || []).length, 2, 'both Worker-deploying phases clean up');
  assert.match(workflow, /WORKER_NAME: amado-cover-fix-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/g);
  assert.doesNotMatch(workflow, /IMAGE_VARIANT_WRITE_APPROVAL|IMAGE_VARIANTS_WRITE_ENABLED|CARD_VARIANTS_|IMAGE_VARIANTS_READ_ENABLED/, 'no switch that affects the live site');
});

test('the pilot phase requires the approved digest and stops when usage cannot be established', () => {
  const pilot = workflow.slice(workflow.indexOf('\n  pilot:'));
  assert.match(pilot, /plan_digest must be the approved SHA-256/);
  assert.match(pilot, /Selection does not match the approved digest/);
  const usageAt = pilot.indexOf('capture-images-usage.mjs'), deployAt = pilot.indexOf('deploy-cover-preview.sh');
  assert.ok(usageAt > 0 && deployAt > usageAt, 'usage is established (set -e) before anything is deployed or generated');
  assert.match(pilot, /set -euo pipefail/);
  assert.ok(pilot.indexOf('card-generation-pilot-check.mjs') > deployAt);
});

test('worker config: Preview bucket is the only writable binding, vars are fixed, and nothing is routed', () => {
  assert.match(toml, /workers_dev = true/);
  assert.doesNotMatch(toml, /\[\[routes\]\]|^routes\s*=|pattern\s*=|zone_name|custom_domain/m);
  assert.match(toml, /binding = "COVER_R2"\nbucket_name = "amadolibros-images-preview"/);
  assert.match(toml, /binding = "PRODUCTION_COVERS_READONLY"\nbucket_name = "amadolibros-images-production"/);
  assert.match(toml, /\[images\]\nbinding = "IMAGES"/);
  assert.doesNotMatch(toml, /nodejs_compat/, 'worker must not need node compat');
});

test('worker modules do not import Node built-ins (they would require nodejs_compat)', () => {
  for (const file of ['../../worker-sync/card-generation.js', '../../worker-sync/card-generation-preview.js']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /from ['"]node:/, file);
  }
});
