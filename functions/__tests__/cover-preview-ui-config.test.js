import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const workflow = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'deploy-cover-r2-preview-ui.yml'),
  'utf8',
);

function runtimeJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') return [];
      return runtimeJsFiles(absolute);
    }
    return entry.isFile() && entry.name.endsWith('.js') ? [absolute] : [];
  });
}

test('workflow R2 UI sólo acepta la rama Preview in-repo y despliega checkout apagado', () => {
  assert.match(workflow, /github\.head_ref == 'agent\/cover-r2-preview-ui-20'/);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/);
  assert.match(workflow, /--branch agent\/cover-r2-preview-ui-20/);
  assert.match(workflow, /PUBLIC_INDEXABLE:\s*'false'/);
  assert.match(workflow, /PUBLIC_CHECKOUT_ENABLED:\s*'false'/);
  assert.doesNotMatch(workflow, /--branch main/);
  assert.doesNotMatch(workflow, /env\.production/);
});

test('workflow prueba 20 copias, card, ficha, bytes y 404 productivo sin secret de portada', () => {
  assert.match(workflow, /status\.with_valid_copy !== 20/);
  assert.match(
    workflow,
    /curl -fsS --retry 5 --retry-all-errors --retry-delay 3 --max-time 180/,
  );
  assert.match(workflow, /\/catalogo\?q=\$SAMPLE_QUERY/);
  assert.match(workflow, /\/libro\/\$SAMPLE_ID/);
  assert.match(workflow, /x-amado-cover-source: r2-preview/i);
  assert.match(workflow, /www\.amadolibros\.com\/preview-cover\/status/);
  assert.doesNotMatch(workflow, /COVER_PILOT_SECRET|SYNC_SECRET/);
});

test('COVER_R2 sólo es referenciado por los dos módulos runtime de portadas', () => {
  const references = runtimeJsFiles(path.join(ROOT, 'functions'))
    .filter(file => readFileSync(file, 'utf8').includes('COVER_R2'))
    .map(file => path.relative(ROOT, file).replaceAll(path.sep, '/'))
    .sort();

  assert.deepEqual(references, [
    'functions/_shared/preview-cover.js',
    'functions/preview-cover/[[path]].js',
  ]);
});

test('módulos COVER_R2 sólo leen con get; no escriben, borran ni enumeran', () => {
  const sources = [
    'functions/_shared/preview-cover.js',
    'functions/preview-cover/[[path]].js',
  ].map(file => readFileSync(path.join(ROOT, file), 'utf8')).join('\n');

  assert.match(sources, /COVER_R2\.get\(|bucket\.get\(/);
  assert.doesNotMatch(
    sources,
    /COVER_R2\.(?:put|delete|list|head|createMultipartUpload|resumeMultipartUpload)\s*\(|bucket\.(?:put|delete|list|head|createMultipartUpload|resumeMultipartUpload)\s*\(/,
  );
});
