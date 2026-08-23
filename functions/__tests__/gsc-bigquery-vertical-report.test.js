import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { analyzeWindow, classifyVertical } from '../../scripts/seo/gsc-bigquery-vertical-analysis.mjs';

const workflowPath = '.github/workflows/gsc-bigquery-vertical-report.yml';
const shellPath = 'scripts/seo/gsc-bigquery-vertical-report.sh';
const analysisPath = 'scripts/seo/gsc-bigquery-vertical-analysis.mjs';

const workflow = () => readFileSync(workflowPath, 'utf8');
const shell = () => readFileSync(shellPath, 'utf8');
const analysis = () => readFileSync(analysisPath, 'utf8');

test('el workflow corre en rama aislada y no despliega web o Worker', () => {
  const source = workflow();
  assert.match(source, /- agent\/gsc-bigquery-verticals-1/);
  assert.doesNotMatch(source, /branches:\s*\[?main\]?/);
  assert.doesNotMatch(source, /wrangler|pages deploy|cloudflare\/pages-action|deploy-worker/i);
  assert.match(source, /bigquery\.readonly/);
});

test('lee sólo la tabla oficial por URL sin crear query jobs', () => {
  const source = shell();
  assert.match(source, /searchdata_url_impression/);
  assert.match(source, /\bbq\b[^\n]* show /);
  assert.match(source, /\bbq\b[^\n]* head /);
  assert.doesNotMatch(source, /searchdata_site_impression|\bbq\b[^\n]* query /);
});

test('el contrato BigQuery es de sólo lectura y evita informes parciales', () => {
  const source = shell();
  assert.match(source, /MAX_ROWS/);
  assert.match(source, /lectura incompleta/);
  assert.doesNotMatch(source, /\bbq\s+(?:rm|mk|load|cp|update|query)\b/i);
});

test('clasifica Tarot y Biblias mediante query o URL', () => {
  assert.equal(classifyVertical({ query: 'Tarot Rider Waite', url: '' }), 'tarot');
  assert.equal(classifyVertical({ query: '', url: 'https://www.amadolibros.com/libros/esoterismo-tarot' }), 'tarot');
  assert.equal(classifyVertical({ query: 'Biblia Reina Valera 1960', url: '' }), 'biblias');
  assert.equal(classifyVertical({ query: 'novela uruguaya', url: '/catalogo' }), null);
});

test('calcula posición con sum_position / impressions + 1', () => {
  const rows = [{
    dataDate: '2026-08-22', siteUrl: 'sc-domain:amadolibros.com', searchType: 'web',
    url: '/libros/esoterismo-tarot', query: 'tarot uruguay', isAnonymizedQuery: false,
    country: 'ury', device: 'MOBILE', clicks: 2, impressions: 10, sumPosition: 40
  }];
  const report = analyzeWindow(rows, { days: 28, maxDate: '2026-08-22', minImpressions: 3 });
  assert.equal(report.summaryRows[0].average_position, 5);
  assert.equal(report.summaryRows[0].ctr, 0.2);
  assert.equal(report.queryRows.length, 1);
});

test('marca posible canibalización sólo con más de una URL para la misma query', () => {
  const base = {
    dataDate: '2026-08-22', siteUrl: 'sc-domain:amadolibros.com', searchType: 'web',
    query: 'biblia reina valera', isAnonymizedQuery: false, country: 'ury', device: 'MOBILE',
    clicks: 0, impressions: 3, sumPosition: 15
  };
  const report = analyzeWindow([
    { ...base, url: '/libro/a' },
    { ...base, url: '/libro/b' }
  ], { days: 28, maxDate: '2026-08-22', minImpressions: 3 });
  assert.equal(report.cannibalizationRows.length, 1);
  assert.equal(report.cannibalizationRows[0].url_count, 2);
});

test('genera ventanas 28/90, CSV seguro y artefactos auditables', () => {
  const source = analysis();
  assert.match(source, /\[28, 90\]/);
  assert.match(source, /average_position >= 4/);
  assert.match(source, /cannibalization: window\.cannibalizationRows/);
  assert.match(source, /`vertical-\$\{name\}\.json`/);
  assert.match(source, /\^\[=\+\\-@\\t\\r\]/);
  assert.match(source, /no crea query jobs/);
});
