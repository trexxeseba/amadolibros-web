import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(
  new URL('../../scripts/seo/gsc-bigquery-dataset-reader-grant.sh', import.meta.url),
  'utf8',
);

test('limita el binding al dataset searchconsole y al principal aprobado', () => {
  assert.match(script, /DATASET_ID="\$\{GSC_BQ_DATASET_ID:-searchconsole\}"/);
  assert.match(script, /serviceAccount:ga4-reporter@amado-libros-analytics\.iam\.gserviceaccount\.com/);
  assert.match(script, /ROLE="roles\/bigquery\.dataViewer"/);
  assert.match(script, /DATASET_REF="\$\{PROJECT_ID\}:\$\{DATASET_ID\}"/);
});

test('rechaza proyecto, número o dataset distintos', () => {
  assert.match(script, /PROJECT_ID" != "amado-libros-analytics"/);
  assert.match(script, /PROJECT_NUMBER" != "\$EXPECTED_PROJECT_NUMBER"/);
  assert.match(script, /DATASET_ID" != "searchconsole"/);
});

test('usa IAM de dataset y no agrega roles a nivel proyecto', () => {
  assert.match(script, /get-iam-policy/);
  assert.match(script, /add-iam-policy-binding/);
  assert.doesNotMatch(script, /gcloud projects add-iam-policy-binding/);
});

test('verifica el binding exacto después de aplicar', () => {
  assert.match(script, /policy-after\.json/);
  assert.match(script, /if ! binding_exists "\$OUTPUT_DIR\/policy-after\.json"/);
});
