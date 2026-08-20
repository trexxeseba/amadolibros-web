import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPaths = [
  '.github/workflows/ga4-export.yml',
  '.github/workflows/gsc-export.yml',
  '.github/workflows/ai-measurement-baseline.yml',
  '.github/workflows/gsc-bigquery-domain-fix.yml',
];

const provider =
  'projects/667747565315/locations/global/workloadIdentityPools/github-actions/providers/amadolibros-web';
const serviceAccount =
  'ga4-reporter@amado-libros-analytics.iam.gserviceaccount.com';

for (const workflowPath of workflowPaths) {
  test(`${workflowPath} autentica con Workload Identity sin claves persistentes`, () => {
    const workflow = readFileSync(workflowPath, 'utf8');

    assert.match(workflow, /^  id-token: write$/m);
    assert.match(workflow, /uses: google-github-actions\/auth@v3/);
    assert.equal(
      workflow.includes(`workload_identity_provider: ${provider}`),
      true,
    );
    assert.equal(workflow.includes(`service_account: ${serviceAccount}`), true);
    assert.doesNotMatch(workflow, /GA4_SERVICE_ACCOUNT_JSON/);
    assert.doesNotMatch(workflow, /credentials_json:/);
  });
}
