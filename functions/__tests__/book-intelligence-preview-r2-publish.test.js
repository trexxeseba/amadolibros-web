import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const script = fs.readFileSync('scripts/seo/publish-book-intelligence-preview-r2.sh', 'utf8');
const wrangler = fs.readFileSync('wrangler.toml', 'utf8');
const workflow = fs.readFileSync('.github/workflows/book-intelligence-enrichment-r2-preview-1.yml', 'utf8');

test('publisher queda encerrado en book-intelligence/preview/v1', () => {
  assert.match(script, /PREFIX="book-intelligence\/preview\/v1"/);
  assert.match(script, /objects\/\$SHA\.json/);
  assert.match(script, /manifest\.json/);
  assert.doesNotMatch(script, /book-intelligence\/production/);
  assert.doesNotMatch(script, /showcase\/v[12]\/cohort\.json/);
  assert.doesNotMatch(script, /staging\/catalog\.json/);
});

test('publisher usa objeto content-addressed, readback y puntero último', () => {
  const putObject = script.indexOf('r2 object put \\\n  "$BUCKET/$OBJECT_KEY"');
  const getObject = script.indexOf('r2 object get \\\n  "$BUCKET/$OBJECT_KEY"');
  const putPointer = script.indexOf('r2 object put \\\n  "$BUCKET/$POINTER_KEY"');
  const getPointer = script.indexOf('r2 object get \\\n  "$BUCKET/$POINTER_KEY"');
  assert.ok(putObject >= 0 && getObject > putObject);
  assert.ok(putPointer > getObject);
  assert.ok(getPointer > putPointer);
  assert.match(script, /REMOTE_SHA/);
  assert.match(script, /cmp "\$POINTER_FILE" "\$REMOTE_POINTER"/);
});

test('manifest remoto conserva entorno preview, SHA y conteos', () => {
  assert.match(script, /environment: 'preview'/);
  assert.match(script, /pointer\.current\.sha256 !== sha/);
  assert.match(script, /pointer\.current\.counts\.total !== object\.entries\.length/);
});

test('workflow sólo publica desde la rama aislada y usa environment preview', () => {
  assert.match(workflow, /agent\/fichas-vidriera-v2-enrichment-r2-preview-1/);
  assert.match(workflow, /environment:\s*\n\s*name: preview/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID/);
  assert.doesNotMatch(workflow, /environment:\s*\n\s*name: production/);
  assert.doesNotMatch(workflow, /pages deploy/);
});

test('Pages Production no recibe CATALOG_BUCKET; sólo Preview puede leer el catálogo R2 directo', () => {
  const previewStart = wrangler.indexOf('[[env.preview.r2_buckets]]');
  const productionStart = wrangler.indexOf('[[env.production.kv_namespaces]]');
  assert.ok(previewStart >= 0 && productionStart > previewStart);
  const previewBlock = wrangler.slice(previewStart, productionStart);
  const productionBlock = wrangler.slice(productionStart);
  assert.match(previewBlock, /binding\s*=\s*"CATALOG_BUCKET"/);
  assert.match(previewBlock, /bucket_name\s*=\s*"amadolibros-catalog"/);
  assert.doesNotMatch(productionBlock, /binding\s*=\s*"CATALOG_BUCKET"/);
});
