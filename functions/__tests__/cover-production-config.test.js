import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const promotion = readFileSync(
  path.join(ROOT, '.github', 'workflows', 'promote-cover-r2-production.yml'),
  'utf8',
);
const deploy = readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy.yml'), 'utf8');
const resolver = readFileSync(
  path.join(ROOT, 'functions', '_shared', 'preview-cover.js'),
  'utf8',
);
const route = readFileSync(
  path.join(ROOT, 'functions', 'preview-cover', '[[path]].js'),
  'utf8',
);

test('promoción R2 sólo corre para la rama productiva in-repo autorizada', () => {
  assert.match(promotion, /github\.head_ref == 'agent\/cover-r2-production-20'/);
  assert.match(promotion, /head\.repo\.full_name == github\.repository/);
  assert.match(promotion, /environment:\s*\n\s+name: production/);
  assert.doesNotMatch(promotion, /push:\s*\n\s+branches:\s*\[main\]/);
});

test('promoción usa buckets separados, verifica SHA y publica el manifest último', () => {
  assert.match(promotion, /SOURCE_BUCKET: amadolibros-images-preview/);
  assert.match(promotion, /TARGET_BUCKET: amadolibros-images-production/);
  assert.match(promotion, /entries\.length !== 20/);
  assert.match(promotion, /sha256sum "\$SOURCE_FILE"/);
  assert.match(promotion, /sha256sum "\$VERIFY_FILE"/);
  assert.match(promotion, /cmp \/tmp\/cover-r2-manifest\.json \/tmp\/cover-r2-production-manifest\.json/);
  const objectLoop = promotion.indexOf("done < /tmp/cover-r2-objects.tsv");
  const manifestPut = promotion.indexOf('$TARGET_BUCKET/covers/v1/manifest.json');
  assert.ok(objectLoop > -1 && manifestPut > objectLoop, 'el manifest debe escribirse después de los objetos');
});

test('runtime R2 admite sólo Preview/Producción y mantiene acceso de lectura', () => {
  assert.match(resolver, /\['preview', 'production'\]\.includes\(ctx\?\.env\?\.APP_ENV\)/);
  assert.match(route, /\['preview', 'production'\]\.includes\(context\.env\?\.APP_ENV\)/);
  assert.match(route, /context\.env\.COVER_R2\.get\(/);
  assert.doesNotMatch(
    `${resolver}\n${route}`,
    /COVER_R2\.(?:put|delete|list|head|createMultipartUpload|resumeMultipartUpload)\s*\(/,
  );
});

test('deploy productivo exige manifest, ficha y bytes R2 antes de quedar verde', () => {
  assert.match(deploy, /name: Verify production R2 covers/);
  assert.match(deploy, /s\.with_valid_copy >= 20/);
  assert.match(deploy, /www\.amadolibros\.com\/libro\/\$SAMPLE_ID/);
  assert.match(deploy, /x-amado-cover-source: r2-production/i);
  assert.match(deploy, /steps\.cover_r2_smoke\.outcome/);
});
