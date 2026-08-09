import { readFile, writeFile } from 'node:fs/promises';

const path = 'scripts/smoke-production.js';
let s = await readFile(path, 'utf8');

function replaceOnce(from, to, label) {
  const count = s.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly 1 match, got ${count}`);
  s = s.replace(from, to);
}

replaceOnce(
  "  { path: '/sitemap.xml', kind: 'sitemap' },",
  [
    "  { path: '/sitemap.xml', kind: 'sitemap-index' },",
    "  { path: '/sitemap-pages.xml', kind: 'sitemap-pages' },",
    "  { path: '/sitemap-categories.xml', kind: 'sitemap-categories' },",
    "  { path: '/sitemap-books-active.xml', kind: 'sitemap-books-active' },",
  ].join('\n'),
  'route list',
);

const helperAnchor = '// ─── Route validators ─────────────────────────────────────────────────────────\n';
const helpers = String.raw`// ─── Sitemap validators ───────────────────────────────────────────────────────

function sitemapLocs(body) {
  return [...String(body || '').matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]);
}

function analyzeSitemapBody(body, kind) {
  if (typeof body !== 'string' || !body.startsWith('<?xml')) {
    return { ok: false, reason: 'invalid XML declaration' };
  }
  if (/<(?:priority|changefreq|lastmod)>/i.test(body)) {
    return { ok: false, reason: 'sitemap reintroduced priority/changefreq/lastmod' };
  }

  const locs = sitemapLocs(body);
  const allOnCanonicalHost = locs.every(value => value.startsWith(BASE_URL + '/'));
  if (!allOnCanonicalHost) return { ok: false, reason: 'sitemap contains non-canonical host/url' };

  if (kind === 'sitemap-index') {
    if (!body.includes('<sitemapindex ')) return { ok: false, reason: 'root sitemap is not a sitemapindex' };
    const required = [
      BASE_URL + '/sitemap-pages.xml',
      BASE_URL + '/sitemap-categories.xml',
      BASE_URL + '/sitemap-books-active.xml',
    ];
    for (const value of required) {
      if (!locs.includes(value)) return { ok: false, reason: 'sitemap index missing ' + value };
    }
    if (locs.some(value => value.includes('paused'))) {
      return { ok: false, reason: 'paused sitemap must not be in root index yet' };
    }
    if (locs.length !== required.length) {
      return { ok: false, reason: 'sitemap index has unexpected segmentos' };
    }
    return { ok: true };
  }

  if (!body.includes('<urlset ')) return { ok: false, reason: kind + ' is not a urlset' };

  if (kind === 'sitemap-pages') {
    const requiredPaths = [
      '/', '/catalogo', '/libros-maria-montessori-uruguay', '/politicas', '/envios',
      '/devoluciones', '/terminos', '/privacidad', '/contacto',
    ];
    for (const path of requiredPaths) {
      const expected = BASE_URL + path;
      if (!locs.includes(expected)) return { ok: false, reason: 'sitemap pages missing ' + path };
    }
    return { ok: true };
  }

  if (kind === 'sitemap-categories') {
    if (locs.length === 0) return { ok: false, reason: 'category sitemap is empty' };
    if (!locs.every(value => value.startsWith(BASE_URL + '/libros/'))) {
      return { ok: false, reason: 'category sitemap contains non-category URL' };
    }
    return { ok: true };
  }

  if (kind === 'sitemap-books-active') {
    if (locs.length === 0) return { ok: false, reason: 'active books sitemap is empty' };
    if (!locs.every(value => value.startsWith(BASE_URL + '/libro/'))) {
      return { ok: false, reason: 'active books sitemap contains non-product URL' };
    }
    return { ok: true };
  }

  return { ok: false, reason: 'unknown sitemap kind' };
}

`;
replaceOnce(helperAnchor, helpers + helperAnchor, 'sitemap helper anchor');

const startMarker = '  // ── /sitemap.xml ─────────────────────────────────────────────────────────\n';
const endMarker = '  // ── /api/health ──────────────────────────────────────────────────────────\n';
const start = s.indexOf(startMarker);
const end = s.indexOf(endMarker, start + startMarker.length);
if (start < 0 || end < 0) throw new Error('sitemap validator block markers not found');
const newBlock = String.raw`  // ── Sitemaps ──────────────────────────────────────────────────────────────
  if (route && route.kind && route.kind.startsWith('sitemap-')) {
    if (status !== 200) return { ok: false, path, reason: 'HTTP ' + status + ' (expected 200)' };
    if (!hasContentType(resp.headers, 'application/xml')) {
      return { ok: false, path, reason: 'Content-Type not XML (got: ' + (resp.headers.get('content-type') || 'none') + ')' };
    }
    const body = await resp.text();
    const analysis = analyzeSitemapBody(body, route.kind);
    if (!analysis.ok) return { ok: false, path, reason: analysis.reason };
    return { ok: true, path };
  }

`;
s = s.slice(0, start) + newBlock + s.slice(end);

replaceOnce(
  '  analyzeCartCheckoutState,\n  resolveCheckoutExpectation,',
  '  analyzeCartCheckoutState,\n  analyzeSitemapBody,\n  resolveCheckoutExpectation,',
  'module exports',
);

await writeFile(path, s);
console.log('smoke sitemap-index patch applied');
