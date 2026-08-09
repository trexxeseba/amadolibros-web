import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = (process.env.SEO_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
const OUT = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
const DATE = process.env.SEO_OUTPUT_DATE || new Date().toISOString().slice(0, 10);

function canonical(html) {
  const tags = String(html || '').match(/<link\s+[^>]*rel=["']canonical["'][^>]*>/gi) || [];
  for (const tag of tags) {
    const match = tag.match(/href=["']([^"']+)["']/i);
    if (match) return match[1];
  }
  return null;
}

function robots(html) {
  const match = String(html || '').match(/<meta\s+[^>]*name=["']robots["'][^>]*>/i);
  if (!match) return null;
  return match[0].match(/content=["']([^"']+)["']/i)?.[1] || null;
}

async function request(url, { redirect = 'manual' } = {}) {
  const response = await fetch(url, {
    redirect,
    headers: {
      'user-agent': 'AmadoLibros-URL-Policy-Audit/1.0',
      'cache-control': 'no-cache',
    },
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('text/html') ? await response.text() : '';
  return {
    status: response.status,
    location: response.headers.get('location'),
    robotsHeader: response.headers.get('x-robots-tag'),
    canonical: canonical(body),
    robotsMeta: robots(body),
    contentType: type,
  };
}

async function firstActiveProduct() {
  const response = await fetch(`${BASE}/sitemap-books-active.xml`, {
    headers: { 'user-agent': 'AmadoLibros-URL-Policy-Audit/1.0' },
  });
  if (!response.ok) throw new Error(`sitemap-books-active.xml HTTP ${response.status}`);
  const xml = await response.text();
  const match = xml.match(/<loc>(https:\/\/www\.amadolibros\.com\/libro\/(MLU\d+)\/([^<]+))<\/loc>/i);
  if (!match) throw new Error('No active product URL found in sitemap-books-active.xml');
  return { url: match[1], id: match[2], slug: match[3] };
}

function matches(value, expected) {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(value || '');
  return value === expected;
}

function evaluate(actual, expected) {
  const failures = [];
  for (const [key, value] of Object.entries(expected)) {
    if (!matches(actual[key], value)) failures.push(`${key}: expected ${String(value)}, got ${String(actual[key])}`);
  }
  return failures;
}

const product = await firstActiveProduct();
const wrongSlug = `${BASE}/libro/${product.id}/slug-inexistente-auditoria`;
const noSlug = `${BASE}/libro/${product.id}`;

const cases = [
  { pattern: '/', url: `${BASE}/`, policy: 'INDEX', expected: { status: 200, canonical: `${BASE}/`, robotsMeta: 'index, follow' } },
  { pattern: '/catalogo', url: `${BASE}/catalogo`, policy: 'INDEX', expected: { status: 200, canonical: `${BASE}/catalogo`, robotsMeta: 'index, follow' } },
  { pattern: '/catalogo?page=2', url: `${BASE}/catalogo?page=2`, policy: 'INDEX PAGINATION', expected: { status: 200, canonical: `${BASE}/catalogo?page=2`, robotsMeta: 'index, follow' } },
  { pattern: '/catalogo?page=1', url: `${BASE}/catalogo?page=1`, policy: 'NORMALIZE', expected: { status: 301, location: '/catalogo' } },
  { pattern: '/catalogo?page=999999', url: `${BASE}/catalogo?page=999999`, policy: 'NOT FOUND', expected: { status: 404, robotsHeader: 'noindex, nofollow' } },
  { pattern: '/catalogo?q=*', url: `${BASE}/catalogo?q=montessori`, policy: 'NOINDEX FILTER', expected: { status: 200, canonical: `${BASE}/catalogo`, robotsMeta: 'noindex, follow' } },
  { pattern: '/catalogo?categoria=*', url: `${BASE}/catalogo?categoria=psicologia`, policy: 'NOINDEX FILTER', expected: { status: 200, canonical: `${BASE}/catalogo`, robotsMeta: /noindex/ } },
  { pattern: '/libros/{cat}', url: `${BASE}/libros/psicologia`, policy: 'INDEX LANDING', expected: { status: 200, canonical: `${BASE}/libros/psicologia`, robotsMeta: 'index, follow' } },
  { pattern: '/libros/{cat}?page=2', url: `${BASE}/libros/psicologia?page=2`, policy: 'INDEX PAGINATION', expected: { status: 200, canonical: `${BASE}/libros/psicologia?page=2`, robotsMeta: 'index, follow' } },
  { pattern: '/libros/{cat}?page=999999', url: `${BASE}/libros/psicologia?page=999999`, policy: 'NOT FOUND', expected: { status: 404, robotsMeta: 'noindex, nofollow' } },
  { pattern: '/libro/{id}/{slug}', url: product.url, policy: 'INDEX PRODUCT', expected: { status: 200, canonical: product.url, robotsMeta: 'index, follow' } },
  { pattern: '/libro/{id}/{wrong-slug}', url: wrongSlug, policy: '301 CANONICAL', expected: { status: 301, location: product.url } },
  { pattern: '/libro/{id}', url: noSlug, policy: '301 CANONICAL', expected: { status: 301, location: product.url } },
  { pattern: '/shop', url: `${BASE}/shop`, policy: 'LEGACY 301', expected: { status: 301, location: `${BASE}/catalogo` } },
  { pattern: '/mas-vendidos', url: `${BASE}/mas-vendidos`, policy: 'LEGACY 301', expected: { status: 301, location: `${BASE}/catalogo` } },
  { pattern: '/page/N', url: `${BASE}/page/94`, policy: 'LEGACY 410', expected: { status: 410, robotsHeader: 'noindex, nofollow' } },
  { pattern: '/tienda/page/N', url: `${BASE}/tienda/page/3`, policy: 'LEGACY 410', expected: { status: 410, robotsHeader: 'noindex, nofollow' } },
  { pattern: '?add-to-cart=*', url: `${BASE}/?add-to-cart=123456`, policy: 'LEGACY 410', expected: { status: 410, robotsHeader: 'noindex, nofollow' } },
  { pattern: '/robots.txt', url: `${BASE}/robots.txt`, policy: 'CRAWL CONTROL', expected: { status: 200 } },
  { pattern: '/sitemap.xml', url: `${BASE}/sitemap.xml`, policy: 'SITEMAP INDEX', expected: { status: 200 } },
  { pattern: '/feed.xml', url: `${BASE}/feed.xml`, policy: 'MERCHANT FEED', expected: { status: 200 } },
];

const results = [];
for (const entry of cases) {
  const actual = await request(entry.url);
  const failures = evaluate(actual, entry.expected);
  results.push({ ...entry, actual, ok: failures.length === 0, failures });
}

const summary = {
  total: results.length,
  passed: results.filter(r => r.ok).length,
  failed: results.filter(r => !r.ok).length,
};

await mkdir(OUT, { recursive: true });
const jsonPath = path.join(OUT, `url-policy-audit-${DATE}.json`);
await writeFile(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, product, summary, results }, null, 2)}\n`);

const rows = results.map(r => `| \`${r.pattern}\` | ${r.policy} | ${r.actual.status} | ${r.actual.canonical || '—'} | ${r.actual.robotsMeta || r.actual.robotsHeader || '—'} | ${r.ok ? 'PASS' : 'FAIL'} |`).join('\n');
const markdown = `# URL policy audit — ${DATE}\n\n` +
  `Producción: ${BASE}\n\n` +
  `Resultado: **${summary.passed}/${summary.total} PASS**.\n\n` +
  `| Patrón | Política | HTTP | Canonical | Robots | Estado |\n|---|---|---:|---|---|---|\n${rows}\n`;
const mdPath = path.join(OUT, `url-policy-audit-${DATE}.md`);
await writeFile(mdPath, markdown);

console.log(JSON.stringify(summary));
for (const r of results) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.pattern} -> ${r.actual.status}${r.failures.length ? ' :: ' + r.failures.join('; ') : ''}`);
}
console.log(`JSON: ${jsonPath}`);
console.log(`MD: ${mdPath}`);
if (summary.failed) process.exitCode = 1;
