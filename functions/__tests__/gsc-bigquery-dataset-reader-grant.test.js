import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const script = readFileSync(
  new URL('../../scripts/seo/gsc-bigquery-dataset-reader-grant.sh', import.meta.url),
  'utf8',
);

test('limita el binding al dataset searchconsole y al principal aprobado', () => {
  assert.match(script, /DATASET_ID="\$\{GSC_BQ_DATASET_ID:-searchconsole\}"/);
  assert.match(script, /REPORTER_EMAIL="ga4-reporter@amado-libros-analytics\.iam\.gserviceaccount\.com"/);
  assert.match(script, /MEMBER="serviceAccount:\$\{REPORTER_EMAIL\}"/);
  assert.match(script, /ROLE="roles\/bigquery\.dataViewer"/);
  assert.match(script, /DATASET_REF="\$\{PROJECT_ID\}:\$\{DATASET_ID\}"/);
});

test('rechaza proyecto, número o dataset distintos', () => {
  assert.match(script, /PROJECT_ID" != "amado-libros-analytics"/);
  assert.match(script, /PROJECT_NUMBER" != "\$EXPECTED_PROJECT_NUMBER"/);
  assert.match(script, /DATASET_ID" != "searchconsole"/);
});

test('usa el ACL READER equivalente a Data Viewer y no agrega roles a nivel proyecto', () => {
  assert.match(script, /datasets\/\$\{DATASET_ID\}/);
  assert.match(script, /role: "READER"/);
  assert.match(script, /userByEmail: \$email/);
  assert.match(script, /updateMode=UPDATE_ACL/);
  assert.doesNotMatch(script, /gcloud projects add-iam-policy-binding/);
  assert.doesNotMatch(script, /bq .*add-iam-policy-binding/);
});

test('conserva el ACL, usa etag y verifica el binding exacto después de aplicar', () => {
  assert.match(script, /\(\.access \/\/ \[\]\) \+ \[/);
  assert.match(script, /If-Match: \$ETAG/);
  assert.match(script, /dataset-patch-request\.json/);
  assert.match(script, /dataset-after\.json/);
  assert.match(script, /if ! binding_exists "\$OUTPUT_DIR\/dataset-after\.json"/);
});
