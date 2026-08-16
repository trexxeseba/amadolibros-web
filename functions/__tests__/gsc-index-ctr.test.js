const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const PAGE = 'https://www.amadolibros.com/libro/MLU1/libro-uno';

function analyticsRow(page, { clicks, impressions, position }) {
  return {
    keys: [page],
    clicks,
    impressions,
    ctr: impressions ? clicks / impressions : 0,
    position,
  };
}

test('prioriza oportunidades CTR con demanda y posición accionable', async () => {
  const { selectCtrOpportunities } = await import('../../scripts/seo/gsc-analysis.mjs');
  const pageRows = [
    analyticsRow(PAGE, { clicks: 0, impressions: 100, position: 8 }),
    analyticsRow('https://www.amadolibros.com/libro/MLU2/libro-dos', { clicks: 20, impressions: 100, position: 7 }),
    analyticsRow('https://www.amadolibros.com/libro/MLU3/libro-tres', { clicks: 0, impressions: 9, position: 6 }),
    analyticsRow('https://www.amadolibros.com/libro/MLU4/libro-cuatro', { clicks: 0, impressions: 100, position: 30 }),
    analyticsRow('https://www.amadolibros.com/catalogo', { clicks: 0, impressions: 1000, position: 5 }),
  ];
  const pageQueryRows = [{
    keys: [PAGE, 'libro uno uruguay'],
    clicks: 0,
    impressions: 80,
    ctr: 0,
    position: 8,
  }];

  const result = selectCtrOpportunities({ pageRows, pageQueryRows });

  assert.equal(result.benchmark.pageCount, 4);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].page, PAGE);
  assert.equal(result.rows[0].topQueries[0].query, 'libro uno uruguay');
  assert.ok(Math.abs(result.rows[0].estimatedMissedClicks - (20 / 309) * 100) < 0.000001);
});

test('arma una muestra estable, sin duplicados y limitada a fichas activas', async () => {
  const { buildInspectionSample } = await import('../../scripts/seo/gsc-analysis.mjs');
  const sitemapUrls = Array.from(
    { length: 500 },
    (_, index) => `https://www.amadolibros.com/libro/MLU${index + 1}/libro-${index + 1}`,
  );
  const pageRows = sitemapUrls.slice(0, 150).map((page, index) => (
    analyticsRow(page, { clicks: index % 3, impressions: 200 - index, position: 8 })
  ));
  const ctrOpportunities = pageRows.slice(0, 20).map((row) => ({ page: row.keys[0] }));

  const first = buildInspectionSample({ sitemapUrls, pageRows, ctrOpportunities, size: 400 });
  const second = buildInspectionSample({ sitemapUrls, pageRows, ctrOpportunities, size: 400 });

  assert.equal(first.length, 400);
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((row) => row.page)).size, 400);
  assert.ok(first.some((row) => row.stratum === 'ctr_or_high_demand'));
  assert.ok(first.some((row) => row.stratum === 'seen_in_search'));
  assert.ok(first.some((row) => row.stratum === 'no_impressions'));
  assert.ok(first.every((row) => sitemapUrls.includes(row.page)));
});

test('resume inspecciones sin confundir errores con verdictos de Google', async () => {
  const { summarizeInspections } = await import('../../scripts/seo/gsc-analysis.mjs');
  const summary = summarizeInspections([
    { stratum: 'seen_in_search', verdict: 'PASS', coverageState: 'Submitted and indexed' },
    { stratum: 'no_impressions', verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' },
    { stratum: 'no_impressions', error: 'HTTP 429' },
  ]);

  assert.equal(summary.requested, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.verdicts.PASS, 1);
  assert.equal(summary.coverageStates['Crawled - currently not indexed'], 1);
});

test('el workflow semanal usa la propiedad correcta, limita la muestra y no despliega', () => {
  const workflow = readFileSync('.github/workflows/gsc-export.yml', 'utf8');

  assert.match(workflow, /default: 'sc-domain:amadolibros\.com'/);
  assert.match(workflow, /default: 400/);
  assert.match(workflow, /GSC_ACTIVE_SITEMAP_URL: https:\/\/www\.amadolibros\.com\/sitemap-books-active\.xml/);
  assert.match(workflow, /GSC_INSPECTION_SAMPLE_SIZE:/);
  assert.doesNotMatch(workflow, /wrangler|cloudflare\/pages-action|deploy-pages/);
});
