import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dayOrdinal,
  parseIsoDate,
  rotationSlice,
  sitemapUrls,
  summarizeInspectionRows,
} from '../../scripts/seo/gsc-inspection-rotation.mjs';

test('parsea fechas y ordinales UTC de forma estable', () => {
  assert.equal(parseIsoDate('2026-08-18').toISOString(), '2026-08-18T00:00:00.000Z');
  assert.equal(dayOrdinal('2026-08-19') - dayOrdinal('2026-08-18'), 1);
  assert.throws(() => parseIsoDate('2026-02-30'), /no es válida/);
});

test('extrae URLs de sitemap y decodifica entidades XML', () => {
  const xml = '<urlset><url><loc>https://www.amadolibros.com/libro/MLU1/a&amp;b</loc></url><url><loc>https://www.amadolibros.com/libro/MLU2/c</loc></url></urlset>';
  assert.deepEqual(sitemapUrls(xml), [
    'https://www.amadolibros.com/libro/MLU1/a&b',
    'https://www.amadolibros.com/libro/MLU2/c',
  ]);
});

test('600 por día cubren 2996 URLs en cinco bloques sin solapamiento', () => {
  const urls = Array.from({ length: 2996 }, (_, i) => `https://www.amadolibros.com/libro/MLU${String(i).padStart(7, '0')}/x`);
  const all = new Set();
  for (let ordinal = 0; ordinal < 5; ordinal += 1) {
    const slice = rotationSlice(urls, 600, ordinal);
    assert.equal(slice.cycleCount, 5);
    assert.equal(slice.rows.length, ordinal === 4 ? 596 : 600);
    for (const url of slice.rows) {
      assert.equal(all.has(url), false, `URL repetida antes de cerrar el ciclo: ${url}`);
      all.add(url);
    }
  }
  assert.equal(all.size, urls.length);
});

test('la rotación envuelve al terminar el ciclo y elimina duplicados de entrada', () => {
  const urls = ['c', 'b', 'a', 'a'];
  assert.deepEqual(rotationSlice(urls, 2, 0).rows, ['a', 'b']);
  assert.deepEqual(rotationSlice(urls, 2, 1).rows, ['c']);
  assert.deepEqual(rotationSlice(urls, 2, 2).rows, ['a', 'b']);
});

test('resume PASS, errores, coverage y canonical mismatch por cohorte', () => {
  const summary = summarizeInspectionRows([
    {
      page: 'https://example.com/a', cohort: 'by_request', verdict: 'PASS',
      coverageState: 'Submitted and indexed', pageFetchState: 'SUCCESSFUL',
      userCanonical: 'https://example.com/a', googleCanonical: 'https://example.com/a', error: '',
    },
    {
      page: 'https://example.com/b', cohort: 'by_request', verdict: 'NEUTRAL',
      coverageState: 'Discovered - currently not indexed', pageFetchState: 'UNKNOWN',
      userCanonical: 'https://example.com/b', googleCanonical: 'https://example.com/c', error: '',
    },
    {
      page: 'https://example.com/c', cohort: 'active', verdict: '', coverageState: '',
      pageFetchState: '', userCanonical: '', googleCanonical: '', error: 'HTTP 429',
    },
  ]);

  assert.equal(summary.requested, 3);
  assert.equal(summary.completed, 2);
  assert.equal(summary.pass, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.canonicalMismatch, 1);
  assert.equal(summary.cohorts.by_request.pass, 1);
  assert.equal(summary.cohorts.active.errors, 1);
  assert.equal(summary.coverageStates['Submitted and indexed'], 1);
});
