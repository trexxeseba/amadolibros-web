import fs from 'node:fs';

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) throw new Error(`${label}: esperado 1 match, encontrados ${count}`);
  return source.replace(from, to);
}

// ---------------------------------------------------------------------------
// 1) /catalogo: page fuera de rango => 404 real (no redirect dependiente del stock)
// ---------------------------------------------------------------------------
{
  const file = 'functions/catalogo.js';
  let s = fs.readFileSync(file, 'utf8');
  const from = `    // Fuera de rango: 302 (no 301) a la última página válida. El destino
    // depende del tamaño actual del catálogo, que cambia con cada sync, así
    // que no debe quedar cacheado como permanente.
    if (pageParam.page > totalPages) {
        const target = new URL(url);
        if (totalPages > 1) target.searchParams.set('page', String(totalPages));
        else target.searchParams.delete('page');
        return new Response(null, {
            status: 302,
            headers: {
                Location: \`${'${target.pathname}${target.search}'}\`,
                'Cache-Control': 'no-store',
            },
        });
    }`;
  const to = `    // Página inexistente: 404 real. No redirigimos a la última página porque
    // el tamaño del catálogo cambia y esa normalización convertiría una URL
    // inexistente en contenido distinto según el sync.
    if (pageParam.page > totalPages) {
        return new Response('<!doctype html><html lang="es"><head><meta charset="UTF-8"><meta name="robots" content="noindex, nofollow"><title>Página no encontrada — Amado Libros</title></head><body><main><h1>Página no encontrada</h1><p>La página del catálogo que buscás no existe.</p><p><a href="/catalogo">Volver al catálogo</a></p></main></body></html>', {
            status: 404,
            headers: {
                'Content-Type': 'text/html;charset=UTF-8',
                'Cache-Control': 'public, max-age=300',
                'X-Robots-Tag': 'noindex, nofollow',
            },
        });
    }`;
  s = replaceOnce(s, from, to, 'catalogo out-of-range');
  fs.writeFileSync(file, s);
}

// ---------------------------------------------------------------------------
// 2) /libros/:categoria: paginación crawlable, self-canonical, 404 overflow
// ---------------------------------------------------------------------------
{
  const file = 'functions/libros/[[path]].js';
  let s = fs.readFileSync(file, 'utf8');

  const helperAnchor = `const MAX_RESULTS = 48;\n`;
  const helpers = `const MAX_RESULTS = 48;
const PAGE_PARAM_RE = /^[1-9][0-9]{0,6}$/;

function parsePageParam(raw) {
    if (raw === null || raw === undefined) return { present: false, valid: true, page: 1 };
    const trimmed = String(raw).trim();
    if (!PAGE_PARAM_RE.test(trimmed)) return { present: true, valid: false, page: 1 };
    return { present: true, valid: true, page: Number(trimmed) };
}

function categoryPath(categoryId, page = 1) {
    return page > 1 ? \`/libros/${'${categoryId}'}?page=${'${page}'}\` : \`/libros/${'${categoryId}'}\`;
}

function paginationWindow(page, totalPages) {
    const wanted = new Set([1, totalPages, page, page - 1, page + 1]);
    const sorted = [...wanted]
        .filter(p => Number.isInteger(p) && p >= 1 && p <= totalPages)
        .sort((a, b) => a - b);
    const cells = [];
    let previous = 0;
    for (const p of sorted) {
        if (previous && p - previous > 1) cells.push('gap');
        cells.push(p);
        previous = p;
    }
    return cells;
}

function paginationHtml({ categoryId, page, totalPages }) {
    if (totalPages <= 1) return '';
    const hrefFor = target => categoryPath(categoryId, target);
    const prev = page > 1
        ? \`<a class="pg-ctl" rel="prev" href="${'${escapeHtml(hrefFor(page - 1))}'}">‹ Anterior</a>\`
        : '<span class="pg-ctl is-off" aria-disabled="true">‹ Anterior</span>';
    const next = page < totalPages
        ? \`<a class="pg-ctl" rel="next" href="${'${escapeHtml(hrefFor(page + 1))}'}">Siguiente ›</a>\`
        : '<span class="pg-ctl is-off" aria-disabled="true">Siguiente ›</span>';
    const numbers = paginationWindow(page, totalPages).map(cell => {
        if (cell === 'gap') return '<span class="pg-gap" aria-hidden="true">…</span>';
        if (cell === page) return \`<span class="pg-num is-current" aria-current="page">${'${cell}'}</span>\`;
        return \`<a class="pg-num" href="${'${escapeHtml(hrefFor(cell))}'}" aria-label="Ir a la página ${'${cell}'}">${'${cell}'}</a>\`;
    }).join('');
    return \`<nav class="pg" aria-label="Paginación de ${'${escapeHtml(categoryId)}'}">
  <div class="pg-row pg-main">${'${prev}'}<span class="pg-status">Página ${'${page}'} de ${'${totalPages}'}</span>${'${next}'}</div>
  <div class="pg-row pg-nums">${'${numbers}'}</div>
</nav>\`;
}

const PAGINATION_STYLES = \`.pg{margin:1.5rem 0 0;display:flex;flex-direction:column;gap:.5rem}.pg-row{display:flex;align-items:center;gap:.3rem}.pg-main{justify-content:space-between}.pg-nums{justify-content:center;flex-wrap:wrap}.pg-ctl,.pg-num,.pg-gap{min-width:44px;min-height:44px;display:inline-flex;align-items:center;justify-content:center;padding:0 .55rem;border-radius:.5rem;font-size:.85rem;text-decoration:none}.pg-ctl,.pg-num{border:1px solid #e2dbd0;background:#fff}.pg-ctl{font-weight:700;white-space:nowrap}.pg-ctl.is-off{color:#aaa;background:#f5f2ee}.pg-num.is-current{background:#18120e;color:#fff;border-color:#18120e;font-weight:800}.pg-gap{min-width:24px}.pg-status{flex:1;text-align:center;font-size:.8rem;color:#6b6157}\`;
`;
  s = replaceOnce(s, helperAnchor, helpers, 'category pagination helpers');

  s = replaceOnce(
    s,
    `function renderPage({ category, items, isPreview, hasParameters, navigationBase }) {\n    const canonical = \`${'${BASE}'}/libros/${'${category.id}'}\`;\n    const visibleItems = items.slice(0, MAX_RESULTS);`,
    `function renderPage({ category, items, isPreview, hasUnexpectedParameters, navigationBase, page, totalPages }) {\n    const canonical = \`${'${BASE}${categoryPath(category.id, page)}'}\`;\n    const offset = (page - 1) * MAX_RESULTS;\n    const visibleItems = items.slice(offset, offset + MAX_RESULTS);`,
    'render signature',
  );

  s = replaceOnce(s, `'position': index + 1,`, `'position': offset + index + 1,`, 'ItemList positions');

  const oldResult = `    const resultText = \`${'${items.length}'} libro${'${items.length === 1 ? \'\' : \'s\'}'} disponible${'${items.length === 1 ? \'\' : \'s\'}'}\`;
    const cards = visibleItems.map((item, index) => cardHtml(item, index, navigationBase)).join('\\n');
    // Parámetros arbitrarios no crean variantes indexables de la landing.
    // La URL limpia es la única que puede entrar al índice.
    const robots = isPreview || hasParameters || items.length === 0
        ? 'noindex, follow'
        : 'index, follow';`;
  const newResult = `    const rangeFrom = items.length === 0 ? 0 : offset + 1;
    const rangeTo = offset + visibleItems.length;
    const resultText = items.length === 0
        ? 'Sin títulos disponibles'
        : totalPages > 1
            ? \`Mostrando ${'${rangeFrom}'}–${'${rangeTo}'} de ${'${items.length}'} libros disponibles\`
            : \`${'${items.length}'} libro${'${items.length === 1 ? \'\' : \'s\'}'} disponible${'${items.length === 1 ? \'\' : \'s\'}'}\`;
    const cards = visibleItems.map((item, index) => cardHtml(item, index, navigationBase)).join('\\n');
    const robots = isPreview || hasUnexpectedParameters || items.length === 0
        ? 'noindex, follow'
        : 'index, follow';
    const pageTitle = page > 1 ? \`${'${category.title}'} — Página ${'${page}'}\` : category.title;
    const pageDescription = page > 1 ? \`${'${category.description}'} Página ${'${page}'} de ${'${totalPages}'}.\` : category.description;
    const pagination = paginationHtml({ categoryId: category.id, page, totalPages });`;
  s = replaceOnce(s, oldResult, newResult, 'category result block');

  s = replaceOnce(s, `<title>${'${escapeHtml(category.title)}'}</title>`, `<title>${'${escapeHtml(pageTitle)}'}</title>`, 'title');
  s = replaceOnce(s, `<meta name="description" content="${'${escapeHtml(category.description)}'}">`, `<meta name="description" content="${'${escapeHtml(pageDescription)}'}">`, 'description');
  s = replaceOnce(s, `<meta property="og:title" content="${'${escapeHtml(category.title)}'}">`, `<meta property="og:title" content="${'${escapeHtml(pageTitle)}'}">`, 'og title');
  s = replaceOnce(s, `<meta property="og:description" content="${'${escapeHtml(category.description)}'}">`, `<meta property="og:description" content="${'${escapeHtml(pageDescription)}'}">`, 'og description');

  s = replaceOnce(
    s,
    `.empty{margin-top:1.5rem;padding:1.5rem;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem}${'${FOOTER_STYLES}${WA_FLOAT_STYLES}'}`,
    `.empty{margin-top:1.5rem;padding:1.5rem;background:#fff;border:1px solid #e2dbd0;border-radius:.8rem}${'${PAGINATION_STYLES}${FOOTER_STYLES}${WA_FLOAT_STYLES}'}`,
    'pagination styles',
  );

  s = replaceOnce(
    s,
    `  <div class="results-head"><h2>Libros disponibles</h2><p>${'${resultText}${items.length > MAX_RESULTS ? ` · mostrando ${MAX_RESULTS}` : \'\'}'}</p></div>\n  ${'${items.length > 0 ? `<section class="books-grid" aria-label="${escapeHtml(category.h1)}">${cards}</section>` : \'<p class="empty">No hay títulos disponibles en esta categoría en este momento. Consultanos por WhatsApp y lo buscamos por encargo.</p>\'}'}\n  ${'${categoryNavHtml(category.id)}'}`,
    `  <div class="results-head"><h2>Libros disponibles</h2><p>${'${resultText}'}</p></div>\n  ${'${items.length > 0 ? `<section class="books-grid" aria-label="${escapeHtml(category.h1)}">${cards}</section>${pagination}` : \'<p class="empty">No hay títulos disponibles en esta categoría en este momento. Consultanos por WhatsApp y lo buscamos por encargo.</p>\'}'}\n  ${'${categoryNavHtml(category.id)}'}`,
    'pagination markup',
  );

  const categoryAnchor = `    const category = findSeoCategory(String(pathParts[0] || '').toLowerCase());
    if (!category) {
        return errorPage(404, 'Categoría no encontrada', 'La categoría que buscás no existe.');
    }
`;
  const categoryReplacement = `${categoryAnchor}
    const requestUrl = new URL(ctx.request.url);
    const pageParam = parsePageParam(requestUrl.searchParams.get('page'));
    if (pageParam.present && (!pageParam.valid || pageParam.page === 1)) {
        const clean = new URL(requestUrl);
        clean.searchParams.delete('page');
        return new Response(null, {
            status: 301,
            headers: { Location: \`${'${clean.pathname}${clean.search}'}\` },
        });
    }
    const hasUnexpectedParameters = [...requestUrl.searchParams.keys()].some(key => key !== 'page')
        || requestUrl.searchParams.getAll('page').length > 1;
`;
  s = replaceOnce(s, categoryAnchor, categoryReplacement, 'category request params');

  const itemsBlock = `    const items = activeItems.filter(item =>
        (categoryData.items[item.id] || [])[0] === category.id
    );
    const isPreview = ctx.env?.APP_ENV === 'preview';
    const navigationBase = isPreview ? new URL(ctx.request.url).origin : BASE;
    const hasParameters = new URL(ctx.request.url).searchParams.size > 0;
    const html = renderPage({
        category,
        items,
        isPreview,
        hasParameters,
        navigationBase,
    });`;
  const itemsReplacement = `    const items = activeItems
        .filter(item => (categoryData.items[item.id] || [])[0] === category.id)
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const totalPages = Math.max(1, Math.ceil(items.length / MAX_RESULTS));
    if (pageParam.page > totalPages) {
        return errorPage(404, 'Página no encontrada', 'La página de esta categoría que buscás no existe.');
    }
    const isPreview = ctx.env?.APP_ENV === 'preview';
    const navigationBase = isPreview ? requestUrl.origin : BASE;
    const html = renderPage({
        category,
        items,
        isPreview,
        hasUnexpectedParameters,
        navigationBase,
        page: pageParam.page,
        totalPages,
    });`;
  s = replaceOnce(s, itemsBlock, itemsReplacement, 'category handler pagination');

  fs.writeFileSync(file, s);
}

// ---------------------------------------------------------------------------
// 3) Auditor: compatible con urlset actual y sitemap index segmentado (#80)
// ---------------------------------------------------------------------------
{
  const file = 'scripts/seo/link-graph-audit.mjs';
  let s = fs.readFileSync(file, 'utf8');
  const anchor = `async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'AmadoLibros-SEO-Baseline/1.0' },
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(\`${'${url}'} respondió HTTP ${'${response.status}'}\`);
  return response.text();
}
`;
  const replacement = `${anchor}
async function collectSitemapBookUrls(rootUrl) {
  const rootOrigin = new URL(rootUrl).origin;
  const queue = [new URL(rootUrl)];
  const queued = new Set(queue.map(url => url.toString()));
  const books = new Map();

  while (queue.length) {
    const current = queue.shift();
    const xml = await fetchText(current);
    for (const loc of sitemapEntries(xml)) {
      const id = bookIdFromUrl(loc);
      if (id) {
        books.set(id, loc);
        continue;
      }
      if (loc.origin === rootOrigin && /\\.xml$/i.test(loc.pathname) && !queued.has(loc.toString())) {
        queued.add(loc.toString());
        queue.push(loc);
      }
    }
  }
  return [...books.values()];
}
`;
  s = replaceOnce(s, anchor, replacement, 'sitemap collector helper');
  s = replaceOnce(
    s,
    `  const sitemapXml = await fetchText(SITEMAP_URL);\n  const sitemapBookUrls = sitemapEntries(sitemapXml).filter((url) => bookIdFromUrl(url));`,
    `  const sitemapBookUrls = await collectSitemapBookUrls(SITEMAP_URL);`,
    'sitemap collector main',
  );
  fs.writeFileSync(file, s);
}

// ---------------------------------------------------------------------------
// 4) Tests portados: overflow ahora es 404, como exige C1
// ---------------------------------------------------------------------------
{
  const file = 'functions/__tests__/catalogo-paginacion.test.js';
  let s = fs.readFileSync(file, 'utf8');
  s = s.replace(
`test('9. ?page fuera de rango redirige 302 a la última página válida', async () => {
  const { response } = await render(\`${'${BASE_URL}'}?page=400\`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/catalogo?page=3');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('10. fuera de rango con una sola página redirige a la URL sin page', async () => {
  CATALOG = buildCatalog(10); // una sola página
  const { response } = await render(\`${'${BASE_URL}'}?page=5\`);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), '/catalogo');
});`,
`test('9. ?page fuera de rango devuelve 404 real', async () => {
  const { response } = await render(\`${'${BASE_URL}'}?page=400\`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Location'), null);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('10. fuera de rango con una sola página también devuelve 404', async () => {
  CATALOG = buildCatalog(10);
  const { response } = await render(\`${'${BASE_URL}'}?page=5\`);
  assert.equal(response.status, 404);
});`,
  );
  s = s.replace(
`test('12. ?q fuera de rango conserva q en el destino del 302', async () => {
  const { response } = await render(\`${'${BASE_URL}'}?q=prueba&page=400\`);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('Location'), /^\\/catalogo\\?q=prueba&page=3$/);
});`,
`test('12. ?q fuera de rango devuelve 404 y no normaliza a otra página', async () => {
  const { response } = await render(\`${'${BASE_URL}'}?q=prueba&page=400\`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Location'), null);
});`,
  );
  if (s.includes("redirige 302 a la última página válida") || s.includes("destino del 302")) {
    throw new Error('No se actualizaron todos los tests 302 obsoletos');
  }
  fs.writeFileSync(file, s);
}

console.log('SEO-INTERNAL-LINK-GRAPH-5 patch aplicado.');
