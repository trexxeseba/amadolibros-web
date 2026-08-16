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
const promotionScript = readFileSync(
  path.join(ROOT, 'scripts', 'promote-cover-r2-production.sh'),
  'utf8',
);
const resolver = readFileSync(
  path.join(ROOT, 'functions', '_shared', 'preview-cover.js'),
  'utf8',
);
const route = readFileSync(
  path.join(ROOT, 'functions', 'preview-cover', '[[path]].js'),
  'utf8',
);

test('PR R2 sólo prueba la rama in-repo autorizada y no abre Producción', () => {
  assert.match(promotion, /github\.head_ref == 'agent\/cover-r2-production-20'/);
  assert.match(promotion, /head\.repo\.full_name == github\.repository/);
  assert.match(promotion, /environment:\s*\n\s+name: preview/);
  assert.doesNotMatch(promotion, /name: production/);
  assert.doesNotMatch(promotion, /seed-production-bucket/);
  assert.doesNotMatch(promotion, /push:\s*\n\s+branches:\s*\[main\]/);
  assert.match(promotion, /Ficha Preview todavía propagándose/);
  assert.match(promotion, /grep -Fq "\/preview-cover\/\$SAMPLE_ID\/0\/"/);
});

test('promoción usa buckets separados, verifica SHA y publica el manifest último', () => {
  assert.match(promotionScript, /SOURCE_BUCKET:-amadolibros-images-preview/);
  assert.match(promotionScript, /TARGET_BUCKET:-amadolibros-images-production/);
  assert.match(promotionScript, /entries\.length !== 20/);
  assert.match(promotionScript, /sha256sum "\$SOURCE_FILE"/);
  assert.match(promotionScript, /sha256sum "\$VERIFY_FILE"/);
  assert.match(promotionScript, /cmp \/tmp\/cover-r2-manifest\.json \/tmp\/cover-r2-production-manifest\.json/);
  const objectLoop = promotionScript.indexOf("done < /tmp/cover-r2-objects.tsv");
  const manifestPut = promotionScript.indexOf('$TARGET_BUCKET/covers/v1/manifest.json');
  assert.ok(objectLoop > -1 && manifestPut > objectLoop, 'el manifest debe escribirse después de los objetos');
});

test('main ya no pisa el manifest completo con el piloto de 20 portadas', () => {
  assert.doesNotMatch(deploy, /Promote 20 validated covers to production R2/);
  assert.doesNotMatch(deploy, /bash scripts\/promote-cover-r2-production\.sh/);
  assert.match(deploy, /name: Deploy via Wrangler/);
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
  assert.match(deploy, /Ficha R2 productiva todavía propagándose/);
  assert.match(deploy, /grep -Fq "\/preview-cover\/\$SAMPLE_ID\/0\/"/);
  assert.match(deploy, /x-amado-cover-source: r2-production/i);
  assert.match(deploy, /steps\.cover_r2_smoke\.outcome/);
});
