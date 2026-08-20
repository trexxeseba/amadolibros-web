import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = '.github/workflows/gsc-bigquery-domain-fix.yml';
const scriptPath = 'scripts/seo/gsc-bigquery-domain-fix.sh';

function workflow() {
  return readFileSync(workflowPath, 'utf8');
}

function script() {
  return readFileSync(scriptPath, 'utf8');
}

test('el workflow de reparación corre en rama aislada y no despliega la web', () => {
  const source = workflow();

  assert.match(source, /name: GSC BigQuery domain restriction repair/);
  assert.match(source, /- agent\/gsc-bigquery-domain-fix/);
  assert.doesNotMatch(source, /branches:\s*\[?main\]?/);
  assert.doesNotMatch(source, /wrangler|pages deploy|npm run build|deploy-worker/i);
  assert.match(source, /GSC_BQ_FIX_MODE: apply/);
});

test('autentica con WIF, habilita sólo la API necesaria y solicita cloud-platform', () => {
  const source = workflow();

  assert.match(source, /^  id-token: write$/m);
  assert.match(source, /uses: google-github-actions\/auth@v3/);
  assert.match(source, /uses: google-github-actions\/setup-gcloud@v3/);
  assert.match(source, /project_id: amado-libros-analytics/);
  assert.match(source, /projects\/667747565315\/locations\/global\/workloadIdentityPools\/github-actions\/providers\/amadolibros-web/);
  assert.match(source, /service_account: ga4-reporter@amado-libros-analytics\.iam\.gserviceaccount\.com/);
  assert.match(source, /https:\/\/www\.googleapis\.com\/auth\/cloud-platform/);
  assert.match(source, /gcloud services enable orgpolicy\.googleapis\.com/);
  assert.match(source, /--project=amado-libros-analytics/);
  assert.doesNotMatch(source, /credentials_json:|SERVICE_ACCOUNT_JSON|private_key/);
});

test('la corrección queda limitada al proyecto analítico conocido', () => {
  const source = script();

  assert.match(source, /PROJECT_ID="\$\{GSC_BQ_PROJECT_ID:-amado-libros-analytics\}"/);
  assert.match(source, /EXPECTED_PROJECT_NUMBER="\$\{GSC_BQ_PROJECT_NUMBER:-667747565315\}"/);
  assert.match(source, /DATASET_ID="\$\{GSC_BQ_DATASET_ID:-searchconsole\}"/);
  assert.match(source, /CONSTRAINT="iam\.allowedPolicyMemberDomains"/);
  assert.match(source, /name: projects\/\$\{PROJECT_NUMBER\}\/policies\/\$\{CONSTRAINT\}/);
  assert.doesNotMatch(source, /name: organizations\//);
  assert.doesNotMatch(source, /--organization=/);
});

test('no pisa una política de proyecto desconocida y el rollback es conservador', () => {
  const source = script();

  assert.match(source, /ya existe una política de proyecto distinta\. No se sobrescribe/);
  assert.match(source, /policy_is_exact_allow_all/);
  assert.match(source, /inheritFromParent: false/);
  assert.match(source, /- allowAll: true/);
  assert.match(source, /el override existente no coincide exactamente con el creado por este lote; no se elimina/);
  assert.match(source, /gcloud org-policies delete/);
});

test('garantiza sólo los dos roles oficiales del exportador de Search Console', () => {
  const source = script();

  assert.match(source, /search-console-data-export@system\.gserviceaccount\.com/);
  assert.match(source, /ensure_export_role roles\/bigquery\.jobUser/);
  assert.match(source, /ensure_export_role roles\/bigquery\.dataEditor/);
  assert.doesNotMatch(source, /roles\/owner|roles\/editor|roles\/bigquery\.admin/);
});

test('no borra datos ni retira privilegios antes de confirmar la recuperación', () => {
  const source = script();

  assert.doesNotMatch(source, /\bbq\s+rm\b|datasets\.delete|tables\.delete|rm -rf/);
  assert.doesNotMatch(source, /remove-iam-policy-binding/);
  assert.match(source, /TARGET_DATE="\$\{GSC_BQ_TARGET_DATE:-2026-08-18\}"/);
  assert.match(source, /ExportLog searchdata_url_impression searchdata_site_impression/);
  assert.match(source, /zero rows immediately after the fix are not treated as a policy failure/);
});
