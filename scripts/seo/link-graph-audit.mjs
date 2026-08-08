import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = (process.env.SEO_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
const SITEMAP_URL = process.env.SEO_SITEMAP_URL || `${BASE_URL}/sitemap.xml`;
const OUTPUT_DIR = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
const OUTPUT_DATE = process.env.SEO_OUTPUT_DATE || new Date().toISOString().slice(0, 10);

const SEED_PATHS = [
  '/',
  '/catalogo',
  '/libros-maria-montessori-uruguay',
  '/libros/infantil-juvenil',
  '/libros/esoterismo-tarot',
  '/libros/medicina-salud',
  '/libros/literatura-ficcion',
  '/libros/idiomas-aprendizaje',
  '/libros/psicologia',
  '/libros/desarrollo-personal',
  '/libros/religion-espiritualidad',
];

function decodeHtml(value) {
  return value
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function extractHrefs(html, pageUrl) {
  const urls = [];
  const re = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    const raw = decodeHtml(match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('mailto:') || raw.startsWith('tel:') || raw.startsWith('javascript:')) continue;
    try {
      urls.push(new URL(raw, pageUrl));
    } catch {
      // Ignore malformed hrefs: the report is about the navigable graph.
    }
  }
  return urls;
}

function bookIdFromUrl(url) {
  if (url.origin !== new URL(BASE_URL).origin) return null;
  const match = url.pathname.match(/^\/libro\/(MLU\d+)(?:\/|$)/i);
  return match ? match[1].toUpperCase() : null;
}

function isPaginationUrl(url) {
  if (url.origin !== new URL(BASE_URL).origin) return false;
  if (/\/page\/\d+\/?$/i.test(url.pathname)) return true;
  const page = url.searchParams.get('page');
  return /^\d+$/.test(page || '') && Number(page) > 1;
}

function sitemapEntries(xml) {
  const locs = [];
  const re = /<loc>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const value = decodeHtml(match[1].trim());
    try {
      locs.push(new URL(value));
    } catch {
      // Ignore malformed sitemap entries, but keep the audit deterministic.
    }
  }
  return locs;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'AmadoLibros-SEO-Baseline/1.0' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const startedAt = new Date().toISOString();
  const sitemapXml = await fetchText(SITEMAP_URL);
  const sitemapBookUrls = sitemapEntries(sitemapXml).filter((url) => bookIdFromUrl(url));
  const sitemapById = new Map(sitemapBookUrls.map((url) => [bookIdFromUrl(url), url.toString()]));

  const queue = SEED_PATHS.map((seed) => new URL(seed, BASE_URL));
  const queued = new Set(queue.map((url) => url.toString()));
  const visited = new Set();
  const linkedBookIds = new Set();
  const pages = [];

  while (queue.length) {
    const pageUrl = queue.shift();
    if (visited.has(pageUrl.toString())) continue;
    visited.add(pageUrl.toString());

    const html = await fetchText(pageUrl);
    const hrefs = extractHrefs(html, pageUrl);
    let bookLinksOnPage = 0;
    let paginationLinksOnPage = 0;

    for (const href of hrefs) {
      const id = bookIdFromUrl(href);
      if (id) {
        linkedBookIds.add(id);
        bookLinksOnPage += 1;
      }
      if (isPaginationUrl(href) && !queued.has(href.toString())) {
        queued.add(href.toString());
        queue.push(href);
        paginationLinksOnPage += 1;
      }
    }

    pages.push({
      url: pageUrl.toString(),
      hrefCount: hrefs.length,
      bookLinks: bookLinksOnPage,
      discoveredPaginationLinks: paginationLinksOnPage,
    });
  }

  const linkedInSitemap = [...linkedBookIds].filter((id) => sitemapById.has(id));
  const orphanIds = [...sitemapById.keys()].filter((id) => !linkedBookIds.has(id)).sort();
  const total = sitemapById.size;
  const linked = linkedInSitemap.length;
  const orphaned = orphanIds.length;
  const linkedPercent = total ? Number(((linked / total) * 100).toFixed(2)) : 0;

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    startedAt,
    baseUrl: BASE_URL,
    sitemapUrl: SITEMAP_URL,
    seeds: SEED_PATHS,
    pagesFetched: pages.length,
    pages,
    totals: {
      sitemapBooks: total,
      linkedBooks: linked,
      orphanBooks: orphaned,
      linkedPercent,
    },
    orphanBookIds: orphanIds,
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const filename = `link-graph-audit-${OUTPUT_DATE}.json`;
  const outputPath = path.join(OUTPUT_DIR, filename);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(JSON.stringify(report.totals));
  console.log(`Escrito: ${outputPath}`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
