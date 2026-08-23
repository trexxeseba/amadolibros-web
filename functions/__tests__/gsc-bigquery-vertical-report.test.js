import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflowPath = '.github/workflows/gsc-bigquery-vertical-report.yml';
const scriptPath = 'scripts/seo/gsc-bigquery-vertical-report.sh';

function workflow() {
  return readFileSync(workflowPath, 'utf8');
}

function script() {
  return readFileSync(scriptPath, 'utf8');
}

test('el workflow corre en rama aislada y no despliega web o Worker', () => {
  const source = workflow();
  assert.match(source, /- agent\/gsc-bigquery-verticals-1/);
  assert.doesNotMatch(source, /branches:\s*\[?main\]?/);
  assert.doesNotMatch(source, /wrangler|pages deploy|cloudflare\/pages-action|deploy-worker/i);
  assert.match(source, /bigquery\.readonly/);
});

test('consulta sólo la tabla oficial de impresiones por URL', () => {
  const source = script();
  assert.match(source, /searchdata_url_impression/);
  assert.match(source, /site_url = '\$\{SITE_URL\}'/);
  assert.match(source, /search_type = 'web'/);
  assert.doesNotMatch(source, /searchdata_site_impression/);
});

test('el contrato BigQuery es de sólo lectura y tiene límite de costo', () => {
  const source = script();
  assert.match(source, /--maximum_bytes_billed="\$MAX_BYTES_BILLED"/);
  assert.doesNotMatch(source, /\b(?:CREATE|INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE)\b/i);
  assert.doesNotMatch(source, /\bbq\s+(?:rm|mk|load|cp|update)\b/i);
});

test('calcula posición media según el esquema oficial de Search Console', () => {
  const source = script();
  assert.match(source, /SAFE_DIVIDE\(SUM\(sum_position\), SUM\(impressions\)\) \+ 1 AS average_position/);
  assert.match(source, /SUM\(clicks\) AS clicks/);
  assert.match(source, /SUM\(impressions\) AS impressions/);
});

test('separa Tarot y Biblias con señales de query y URL', () => {
  const source = script();
  assert.match(source, /libros\/esoterismo-tarot/);
  assert.match(source, /rider\[ -\]\?waite/);
  assert.match(source, /reina\[ -\]\?valera/);
  assert.match(source, /rvr\[ -\]\?/);
  assert.match(source, /jerusal\[ée\]n/);
  assert.match(source, /THEN 'tarot'/);
  assert.match(source, /THEN 'biblias'/);
});

test('genera ventanas 28/90 y detecta oportunidades y canibalización', () => {
  const source = script();
  assert.match(source, /run_window 28/);
  assert.match(source, /run_window 90/);
  assert.match(source, /BETWEEN 4 AND 20/);
  assert.match(source, /HAVING COUNT\(\*\) > 1/);
  assert.match(source, /vertical-cannibalization\.json/);
  assert.match(source, /recortadas automáticamente a los datos realmente disponibles/);
});

