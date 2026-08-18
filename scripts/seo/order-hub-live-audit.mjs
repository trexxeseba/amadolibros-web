import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = (process.env.SEO_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
const PRODUCTION_ORIGIN = 'https://www.amadolibros.com';
const EXPECT_INDEXABLE = process.env.SEO_EXPECT_INDEXABLE !== 'false';
const OUTPUT_DIR = process.env.SEO_OUTPUT_DIR || 'artifacts/seo-order-hub';
const PAGE_SIZE = 48;
const CONCURRENCY = Math.max(1, Math.min(12, Number(process.env.SEO_CONCURRENCY) || 8));

function decodeHtml(value) {
  return String(value || '')
    .replaceAll('&amp;', '&').replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function sitemapLocs(xml) {
  return [...xml.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map(match => decodeHtml(match[1].trim()));
}

function bookId(value) {
  try {
    const url = new URL(value, BASE_URL);
    return url.pathname.match(/^\/libro\/(MLU\d+)(?:\/|$)/i)?.[1]?.toUpperCase() || null;
  } catch {
    return null;
  }
}

function hrefs(html) {
  return [...html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .map(match => decodeHtml(match[1] ?? match[2] ?? ''))
    .filter(Boolean);
}

function uniqueBookIds(html) {
  return new Set(hrefs(html).map(bookId).filter(Boolean));
}

function sectionHtml(html, className) {
  const escapedClass = String(className || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(html || '').match(new RegExp(`<section class="${escapedClass}"[\\s\\S]*?<\\/section>`, 'i'))?.[0] || '';
}

function primaryBookIds(html) {
  return uniqueBookIds(sectionHtml(html, 'book-grid'));
}

function priorityBookIds(html) {
  return uniqueBookIds(sectionHtml(html, 'priority-links'));
}

function pageLinks(html) {
  const pages = new Set([1]);
  for (const href of hrefs(html)) {
    try {
      const url = new URL(href, BASE_URL);
      if (url.pathname !== '/libros-por-encargo') continue;
      const raw = url.searchParams.get('page');
      if (!raw) {
        pages.add(1);
        continue;
      }
      if (/^[1-9]\d*$/.test(raw)) pages.add(Number(raw));
    } catch {
      // Otra validación comprueba la cobertura completa.
    }
  }
  return pages;
}

function canonical(html) {
  return decodeHtml(html.match(/<link\s+rel="canonical"\s+href="([^"]+)"/i)?.[1] || '');
}

function robots(html) {
  return String(html.match(/<meta\s+name="robots"\s+content="([^"]+)"/i)?.[1] || '').toLowerCase();
}

async function fetchHtml(pathname, userAgent = 'AmadoLibros-OrderHub-Audit/1.0') {
  const url = new URL(pathname, BASE_URL).toString();
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': userAgent },
    signal: AbortSignal.timeout(45_000),
  });
  return {
    url,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    html: await response.text(),
  };
}

async function mapConcurrent(values, mapper) {
  const results = new Array(values.length);
  let cursor = 0;
  async function worker() {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, worker));
  return results;
}

function setDifference(left, right) {
  return [...left].filter(value => !right.has(value)).sort();
}

async function main() {
  const failures = [];
  const pausedSitemapResponse = await fetch(`${BASE_URL}/sitemap-books-paused.xml`, {
    headers: { 'user-agent': 'AmadoLibros-OrderHub-Audit/1.0' },
    signal: AbortSignal.timeout(45_000),
  });
  if (!pausedSitemapResponse.ok) {
    throw new Error(`sitemap-books-paused.xml respondió HTTP ${pausedSitemapResponse.status}`);
  }
  const sitemapIds = new Set(
    sitemapLocs(await pausedSitemapResponse.text()).map(bookId).filter(Boolean),
  );
  if (sitemapIds.size === 0) failures.push('El sitemap pausado no contiene fichas.');

  const expectedPages = Math.max(1, Math.ceil(sitemapIds.size / PAGE_SIZE));
  const rootDesktop = await fetchHtml('/libros-por-encargo', 'Mozilla/5.0 desktop AmadoAudit');
  const rootMobile = await fetchHtml('/libros-por-encargo', 'Mozilla/5.0 Mobile Safari AmadoAudit');
  if (rootDesktop.status !== 200) failures.push(`El hub respondió HTTP ${rootDesktop.status}.`);
  if (rootMobile.status !== 200) failures.push(`El hub mobile respondió HTTP ${rootMobile.status}.`);

  const desktopBooks = uniqueBookIds(rootDesktop.html);
  const mobileBooks = uniqueBookIds(rootMobile.html);
  const desktopPrimary = primaryBookIds(rootDesktop.html);
  const mobilePrimary = primaryBookIds(rootMobile.html);
  const desktopPriority = priorityBookIds(rootDesktop.html);
  const mobilePriority = priorityBookIds(rootMobile.html);
  const desktopPages = pageLinks(rootDesktop.html);
  const mobilePages = pageLinks(rootMobile.html);
  if (setDifference(desktopBooks, mobileBooks).length || setDifference(mobileBooks, desktopBooks).length) {
    failures.push('Mobile y desktop no entregan las mismas fichas en el HTML SSR.');
  }
  if (setDifference(desktopPrimary, mobilePrimary).length || setDifference(mobilePrimary, desktopPrimary).length) {
    failures.push('Mobile y desktop no entregan el mismo lote principal del hub.');
  }
  if (setDifference(desktopPriority, mobilePriority).length || setDifference(mobilePriority, desktopPriority).length) {
    failures.push('Mobile y desktop no entregan los mismos enlaces prioritarios.');
  }
  if (setDifference(desktopPages, mobilePages).length || setDifference(mobilePages, desktopPages).length) {
    failures.push('Mobile y desktop no entregan los mismos enlaces de paginación.');
  }
  for (let page = 1; page <= expectedPages; page += 1) {
    if (!desktopPages.has(page)) failures.push(`La portada del hub no enlaza la página ${page}.`);
  }
  if (expectedPages > 1 && desktopPriority.size === 0) {
    failures.push('La portada del hub no publica enlaces prioritarios a fichas con demanda GSC.');
  }
  const priorityOutsideSitemap = setDifference(desktopPriority, sitemapIds);
  if (priorityOutsideSitemap.length) {
    failures.push(`${priorityOutsideSitemap.length} enlaces prioritarios no pertenecen al sitemap pausado.`);
  }
  const priorityDuplicatedOnPageOne = [...desktopPriority].filter(id => desktopPrimary.has(id));
  if (priorityDuplicatedOnPageOne.length) {
    failures.push(`${priorityDuplicatedOnPageOne.length} enlaces prioritarios duplican fichas ya visibles en el primer lote.`);
  }

  const pageNumbers = Array.from({ length: expectedPages }, (_, index) => index + 1);
  const pages = await mapConcurrent(pageNumbers, async page => {
    const pathname = page === 1 ? '/libros-por-encargo' : `/libros-por-encargo?page=${page}`;
    const result = page === 1 ? rootDesktop : await fetchHtml(pathname);
    const ids = primaryBookIds(result.html);
    const extraIds = setDifference(uniqueBookIds(result.html), ids);
    const expectedCanonical = `${PRODUCTION_ORIGIN}${pathname}`;
    const metaRobots = robots(result.html);
    const xRobots = String(result.headers['x-robots-tag'] || '').toLowerCase();
    const expectedItems = page < expectedPages
      ? PAGE_SIZE
      : Math.max(1, sitemapIds.size - ((expectedPages - 1) * PAGE_SIZE));

    if (result.status !== 200) failures.push(`${pathname} respondió HTTP ${result.status}.`);
    if (canonical(result.html) !== expectedCanonical) {
      failures.push(`${pathname} canonicalizó a ${canonical(result.html) || 'vacío'}.`);
    }
    if (ids.size !== expectedItems) {
      failures.push(`${pathname} enlaza ${ids.size} fichas principales únicas; se esperaban ${expectedItems}.`);
    }
    if (page > 1 && extraIds.length) {
      failures.push(`${pathname} agrega ${extraIds.length} enlaces de ficha fuera de su lote principal.`);
    }
    if (/"@type"\s*:\s*"Offer"|"offers"\s*:|priceCurrency/.test(result.html)) {
      failures.push(`${pathname} publica una oferta o precio para libros por encargo.`);
    }
    if (EXPECT_INDEXABLE) {
      if (!metaRobots.includes('index') || metaRobots.includes('noindex')) {
        failures.push(`${pathname} no está marcado index, follow en producción.`);
      }
      if (xRobots.includes('noindex')) failures.push(`${pathname} recibe X-Robots-Tag noindex en producción.`);
    } else {
      if (!metaRobots.includes('noindex')) failures.push(`${pathname} no tiene meta noindex en Preview.`);
      if (!xRobots.includes('noindex')) failures.push(`${pathname} no tiene X-Robots-Tag noindex en Preview.`);
    }

    return {
      page, pathname, status: result.status, canonical: canonical(result.html),
      robots: metaRobots, xRobotsTag: xRobots, uniqueBookLinks: ids.size,
      extraBookLinks: extraIds.length, ids: [...ids],
    };
  });

  const allIds = new Set();
  const duplicateIds = new Set();
  for (const page of pages) {
    for (const id of page.ids) {
      if (allIds.has(id)) duplicateIds.add(id);
      allIds.add(id);
    }
  }
  const missingFromHub = setDifference(sitemapIds, allIds);
  const outsideSitemap = setDifference(allIds, sitemapIds);
  if (duplicateIds.size) failures.push(`${duplicateIds.size} fichas aparecen en más de una página principal del hub.`);
  if (missingFromHub.length) failures.push(`${missingFromHub.length} fichas del sitemap pausado no tienen enlace desde el grafo principal del hub.`);
  if (outsideSitemap.length) failures.push(`${outsideSitemap.length} fichas del grafo principal no pertenecen al sitemap pausado.`);

  const invalidPage = await fetchHtml(`/libros-por-encargo?page=${expectedPages + 1}`);
  if (invalidPage.status !== 404) failures.push('Una página fuera de rango no devuelve 404.');
  if (!robots(invalidPage.html).includes('noindex')) failures.push('La página fuera de rango no declara noindex.');

  const report = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    expectIndexable: EXPECT_INDEXABLE,
    pageSize: PAGE_SIZE,
    sitemapBooks: sitemapIds.size,
    expectedPages,
    pagesAudited: pages.length,
    linkedBooks: allIds.size,
    priorityBookLinks: desktopPriority.size,
    priorityBookIds: [...desktopPriority],
    missingFromHub,
    outsideSitemap,
    duplicateIds: [...duplicateIds].sort(),
    mobileParity: {
      books: desktopBooks.size === mobileBooks.size && setDifference(desktopBooks, mobileBooks).length === 0,
      primary: desktopPrimary.size === mobilePrimary.size && setDifference(desktopPrimary, mobilePrimary).length === 0,
      priority: desktopPriority.size === mobilePriority.size && setDifference(desktopPriority, mobilePriority).length === 0,
      pages: desktopPages.size === mobilePages.size && setDifference(desktopPages, mobilePages).length === 0,
    },
    invalidPageStatus: invalidPage.status,
    failures,
    pages: pages.map(({ ids, ...page }) => page),
  };

  await mkdir(OUTPUT_DIR, { recursive: true });
  const outputPath = path.join(OUTPUT_DIR, 'order-hub-live-audit.json');
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    sitemapBooks: report.sitemapBooks,
    pages: report.pagesAudited,
    linkedBooks: report.linkedBooks,
    priorityBookLinks: report.priorityBookLinks,
    failures: report.failures.length,
  }));
  console.log(`Escrito: ${outputPath}`);

  if (failures.length) {
    throw new Error(`Auditoría del hub falló: ${failures.join(' | ')}`);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});