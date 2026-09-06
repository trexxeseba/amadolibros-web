import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../qw2-preview-seed.js';

test('el sembrador temporal rechaza GET, ausencia de secreto y entornos no Preview', async () => {
  for (const [method, env, auth] of [
    ['GET',{APP_ENV:'preview',PREVIEW_SEED_TOKEN:'test'},'Bearer test'],
    ['POST',{APP_ENV:'preview'},'Bearer undefined'],
    ['POST',{APP_ENV:'production',PREVIEW_SEED_TOKEN:'test'},'Bearer test'],
    ['POST',{APP_ENV:'preview',PREVIEW_SEED_TOKEN:'test'},'Bearer other'],
  ]) {
    const r=await worker.fetch(new Request('https://seed.example/',{method,headers:{authorization:auth}}),env);
    assert.equal(r.status,403);
  }
});

test('el sembrador sólo puede enlazarse al bucket de imágenes Preview', () => {
  const config=readFileSync(new URL('../qw2-preview.wrangler.toml',import.meta.url),'utf8');
  assert.equal((config.match(/bucket_name\s*=/g)||[]).length,1);
  assert.match(config,/bucket_name = "amadolibros-images-preview"/);
  assert.match(config,/APP_ENV = "preview"/);
  assert.doesNotMatch(config,/production|\[triggers\]|\[\[routes\]\]/);
});
