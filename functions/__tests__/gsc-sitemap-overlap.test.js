import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSitemapCohorts } from '../../scripts/seo/sitemap-overlap.mjs';

const urls = (prefix, n) => Array.from({ length: n }, (_, i) => `https://www.amadolibros.com/libro/${prefix}${i}`);

test('sin superposición no cambia nada', () => {
  const active = urls('a', 100);
  const paused = urls('p', 50);
  const out = reconcileSitemapCohorts(active, paused);
  assert.deepEqual(out.overlap, []);
  assert.equal(out.pausedUrls.length, 50);
});

test('una URL en los dos sitemaps se tolera, cuenta como activa y queda registrada', () => {
  const active = urls('a', 6994);
  const paused = [...urls('p', 2962), active[10]];
  const out = reconcileSitemapCohorts(active, paused);
  assert.deepEqual(out.overlap, [active[10]]);
  assert.equal(out.pausedUrls.length, 2962);
  assert.ok(!out.pausedUrls.includes(active[10]));
  assert.equal(out.activeUrls.length, 6994);
});

test('una superposición grande sí frena la corrida', () => {
  const active = urls('a', 6994);
  const paused = [...urls('p', 2900), ...active.slice(0, 80)];
  assert.throws(() => reconcileSitemapCohorts(active, paused), /se superponen en 80 URLs/);
});
