import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOrderHubHandler } from '../libros-por-encargo.js';
import { pageSitemapEntries, STATIC_SITEMAP_PAGES } from '../sitemap-pages.xml.js';
import {
  ORDER_HUB_PAGE_SIZE,
  ORDER_HUB_PRIORITY_LINK_LIMIT,
  orderHubBooks,
  orderHubDemandBooks,
  orderHubPageCount,
  orderHubPageSlice,
  orderHubPaginationEntries,
  orderHubPath,
  parseOrderHubPage,
} from '../_shared/order-hub.js';
import { PAUSED_SEO_COHORT } from '../_shared/paused-seo-cohort.js';

function pausedIndex(count = 120) {
  return {
    items: PAUSED_SEO_COHORT.slice(0, count).map((entry, index) => ({
      id: entry.id,
      title: `Libro por encargo ${String(index + 1).padStart(3, '0')}`,
      author: `Autor ${index + 1}`,
      isbn: entry.isbn,
      thumbnail: `https://example.com/${entry.id}.jpg`,
      status: 'paused',
    })),
  };
}

function context(path, appEnv = 'production', userAgent = 'Mozilla/5.0') {
  return {
    request: new Request(`https://www.amadolibros.com${path}`, {
      headers: { 'user-agent': userAgent },
    }),
    env: { APP_ENV: appEnv },
  };
}

function uniqueBookIds(html) {
  return new Set(
    [...html.matchAll(/href="\/libro\/(MLU\d+)\/[^\"]+"/g)].map(match => match[1]),
  );
}

function sectionBookIds(html, className) {
  const section = html.match(new RegExp(`<section class="${className}"[\\s\\S]*?<\\/section>`))?.[0] || '';
  return uniqueBookIds(section);
}

test('la cohorte del hub conserva orden estable y excluye activos o no aprobados', () => {
  const approved = PAUSED_SEO_COHORT.slice(0, 3);
  const index = {
    items: [
      { id: approved[1].id, title: 'Segundo', status: 'paused' },
      { id: approved[0].id, title: 'Primero', status: 'paused' },
      { id: approved[2].id, title: 'Activo', status: 'active' },
      { id: 'MLU999999999', title: 'Fuera de cohorte', status: 'paused' },
    ],
  };

  assert.deepEqual(orderHubBooks(index).map(book => book.id), [approved[0].id, approved[1].id]);
  assert.equal(ORDER_HUB_PAGE_SIZE, 48);
  assert.equal(orderHubPageCount(97), 3);
  assert.equal(orderHubPath(1), '/libros-por-encargo');
  assert.equal(orderHubPath(3), '/libros-por-encargo?page=3');
});

test('la prioridad GSC enlaza 24 fichas con demanda real fuera del primer lote', () => {
  const index = pausedIndex(160);
  const books = orderHubBooks(index);
  const firstPage = orderHubPageSlice(books, 1);
  const firstPageIds = new Set(firstPage.map(book => book.id));
  const priority = orderHubDemandBooks(index, { excludeIds: [...firstPageIds] });
  const cohortById = new Map(PAUSED_SEO_COHORT.map(entry => [entry.id, entry]));

  assert.equal(priority.length, ORDER_HUB_PRIORITY_LINK_LIMIT);
  for (const book of priority) {
    assert.equal(firstPageIds.has(book.id), false, `duplicado en página 1: ${book.id}`);
    const entry = cohortById.get(book.id);
    assert.equal(entry?.source, 'gsc-demand');
    assert.ok((Number(entry?.impressions) || 0) > 0 || (Number(entry?.clicks) || 0) > 0);
  }
});

test('el parser normaliza sólo page=1 y rechaza páginas ambiguas', () => {
  assert.deepEqual(parseOrderHubPage(null), { present: false, valid: true, page: 1 });
  assert.deepEqual(parseOrderHubPage('1'), { present: true, valid: true, page: 1 });
  assert.deepEqual(parseOrderHubPage('02'), { present: true, valid: false, page: null });
  assert.deepEqual(parseOrderHubPage('0'), { present: true, valid: false, page: null });
  assert.deepEqual(parseOrderHubPage('dos'), { present: true, valid: false, page: null });
});

test('producción entrega 48 fichas principales, canonical propio y sin Offer inventado', async () => {
  const index = pausedIndex(120);
  const handler = createOrderHubHandler({ fetchPaused: async () => index });
  const response = await handler(context('/libros-por-encargo'));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /<meta name="robots" content="index, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros-por-encargo">/);
  assert.equal(sectionBookIds(html, 'book-grid').size, 48);
  assert.match(html, /href="\/libros-por-encargo\?page=2"/);
  assert.match(html, /href="\/libros-por-encargo\?page=3"/);
  assert.doesNotMatch(html, /"@type":"Offer"|priceCurrency|itemCondition/);
  assert.match(html, /Edición, disponibilidad, precio y plazo a confirmar/);
});

test('la raíz agrega enlaces prioritarios sin imágenes extra y páginas 2+ no los duplican', async () => {
  const index = pausedIndex(160);
  const books = orderHubBooks(index);
  const firstPage = orderHubPageSlice(books, 1);
  const expectedPriority = orderHubDemandBooks(index, { excludeIds: firstPage.map(book => book.id) });
  const handler = createOrderHubHandler({ fetchPaused: async () => index });

  const root = await handler(context('/libros-por-encargo'));
  const rootHtml = await root.text();
  const prioritySection = rootHtml.match(/<section class="priority-links"[\s\S]*?<\/section>/)?.[0] || '';
  assert.deepEqual([...sectionBookIds(rootHtml, 'priority-links')], expectedPriority.map(book => book.id));
  assert.doesNotMatch(prioritySection, /<img\b/i);
  assert.equal(uniqueBookIds(rootHtml).size, 48 + expectedPriority.length);

  const pageTwo = await handler(context('/libros-por-encargo?page=2'));
  const pageTwoHtml = await pageTwo.text();
  assert.doesNotMatch(pageTwoHtml, /class="priority-links"/);
});

test('cada página paginada tiene canonical, prev, next y su propio lote estable', async () => {
  const handler = createOrderHubHandler({ fetchPaused: async () => pausedIndex(120) });
  const response = await handler(context('/libros-por-encargo?page=2'));
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Página 2 de 3/);
  assert.match(html, /rel="prev" href="https:\/\/www\.amadolibros\.com\/libros-por-encargo"/);
  assert.match(html, /rel="next" href="https:\/\/www\.amadolibros\.com\/libros-por-encargo\?page=3"/);
  assert.match(html, /rel="canonical" href="https:\/\/www\.amadolibros\.com\/libros-por-encargo\?page=2"/);
  const ids = uniqueBookIds(html);
  assert.equal(ids.size, 48);
  assert.ok(ids.has(PAUSED_SEO_COHORT[48].id));
  assert.ok(ids.has(PAUSED_SEO_COHORT[95].id));
  assert.ok(!ids.has(PAUSED_SEO_COHORT[0].id));
});

test('page=1 redirige y páginas inválidas o fuera de rango devuelven 404 noindex', async () => {
  const handler = createOrderHubHandler({ fetchPaused: async () => pausedIndex(60) });
  const normalized = await handler(context('/libros-por-encargo?page=1'));
  assert.equal(normalized.status, 301);
  assert.equal(normalized.headers.get('location'), 'https://www.amadolibros.com/libros-por-encargo');

  for (const path of ['/libros-por-encargo?page=0', '/libros-por-encargo?page=abc', '/libros-por-encargo?page=3']) {
    const response = await handler(context(path));
    const html = await response.text();
    assert.equal(response.status, 404, path);
    assert.match(response.headers.get('x-robots-tag'), /noindex, nofollow/);
    assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  }
});

test('Preview es noindex y entrega exactamente los mismos enlaces a mobile y desktop', async () => {
  const index = pausedIndex(100);
  const handler = createOrderHubHandler({ fetchPaused: async () => index });
  const desktop = await handler(context('/libros-por-encargo', 'preview', 'Mozilla/5.0 desktop'));
  const mobile = await handler(context('/libros-por-encargo', 'preview', 'Mozilla/5.0 Mobile Safari'));
  const desktopHtml = await desktop.text();
  const mobileHtml = await mobile.text();

  assert.match(desktopHtml, /<meta name="robots" content="noindex, nofollow">/);
  assert.deepEqual([...uniqueBookIds(mobileHtml)], [...uniqueBookIds(desktopHtml)]);
  assert.equal(sectionBookIds(desktopHtml, 'book-grid').size, 48);
  assert.deepEqual(
    [...sectionBookIds(mobileHtml, 'priority-links')],
    [...sectionBookIds(desktopHtml, 'priority-links')],
  );
});

test('si el catálogo pausado falla, el hub devuelve 503 y nunca una página indexable vacía', async () => {
  const handler = createOrderHubHandler({ fetchPaused: async () => null });
  const response = await handler(context('/libros-por-encargo'));
  const html = await response.text();

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '60');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.match(html, /catálogo por encargo está actualizándose/);
});

test('el sitemap dinámico sólo agrega páginas 2+ y usa el mismo tamaño de página', () => {
  const entries = orderHubPaginationEntries(pausedIndex(120), 'https://www.amadolibros.com');
  assert.deepEqual(entries, [
    { loc: 'https://www.amadolibros.com/libros-por-encargo?page=2' },
    { loc: 'https://www.amadolibros.com/libros-por-encargo?page=3' },
  ]);
});

test('la cohorte completa queda cubierta una sola vez en un máximo de 63 páginas', () => {
  const books = orderHubBooks(pausedIndex(PAUSED_SEO_COHORT.length));
  const seen = new Set();

  assert.equal(books.length, PAUSED_SEO_COHORT.length);
  assert.equal(orderHubPageCount(books), 63);
  for (let page = 1; page <= orderHubPageCount(books); page += 1) {
    for (const book of books.slice((page - 1) * ORDER_HUB_PAGE_SIZE, page * ORDER_HUB_PAGE_SIZE)) {
      assert.equal(seen.has(book.id), false, `duplicado ${book.id}`);
      seen.add(book.id);
    }
  }
  assert.equal(seen.size, PAUSED_SEO_COHORT.length);
});

test('sitemap-pages publica la raíz y sólo las páginas vigentes 2..N', async () => {
  const entries = await pageSitemapEntries({}, { loadPausedIndex: async () => pausedIndex(120) });
  const locs = entries.map(entry => entry.loc);

  assert.ok(STATIC_SITEMAP_PAGES.includes('https://www.amadolibros.com/libros-por-encargo'));
  assert.ok(locs.includes('https://www.amadolibros.com/libros-por-encargo'));
  assert.ok(locs.includes('https://www.amadolibros.com/libros-por-encargo?page=2'));
  assert.ok(locs.includes('https://www.amadolibros.com/libros-por-encargo?page=3'));
  assert.ok(!locs.includes('https://www.amadolibros.com/libros-por-encargo?page=4'));
});

test('la home ofrece el pedido exacto y el hub mantiene la landing informativa', () => {
  const home = readFileSync('astro-front/src/pages/index.astro', 'utf8');
  const access = readFileSync('astro-front/src/components/OrderHubAccess.astro', 'utf8');
  const hub = readFileSync('functions/libros-por-encargo.js', 'utf8');

  assert.match(home, /import OrderHubAccess/);
  assert.match(home, /<OrderHubAccess \/>/);
  assert.match(access, /href="\/pedir-libro\/\?tipo=exacto"/);
  assert.match(access, /disponibilidad, el precio y el plazo se confirman/i);
  assert.match(hub, /href="\/libros-agotados-importados-uruguay"/);
  assert.doesNotMatch(access, /priceCurrency|"@type":\s*"Offer"/);
});