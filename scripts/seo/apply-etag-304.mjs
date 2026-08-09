import { readFile, writeFile } from 'node:fs/promises';

async function patch(path, edits) {
  let source = await readFile(path, 'utf8');
  for (const [label, from, to] of edits) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw new Error(`${path} ${label}: expected 1 match, got ${count}`);
    source = source.replace(from, to);
  }
  await writeFile(path, source);
}

await patch('functions/libro/[[path]].js', [
  ['import',
    "import { BASE, fetchCatalog, fetchPausedItem } from '../_shared/catalog.js';",
    "import { BASE, fetchCatalog, fetchPausedItem } from '../_shared/catalog.js';\nimport { conditionalResponse } from '../_shared/http-conditional.js';"],
  ['response',
`    return new Response(renderPage(item, slug, isPreview, waitlistSiteKey), {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });`,
`    const html = renderPage(item, slug, isPreview, waitlistSiteKey);
    return conditionalResponse(context.request, html, {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });`],
]);

await patch('functions/catalogo.js', [
  ['import',
    "import { slugify } from './_shared/slug.js';",
    "import { slugify } from './_shared/slug.js';\nimport { conditionalResponse } from './_shared/http-conditional.js';"],
  ['response',
`    return new Response(html, {
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': isIndex ? 'public, max-age=3600' : 'public, max-age=300',
            'server-timing': serverTiming,
            'x-cache-status': cacheStatus,
            'x-perf-cache-hits': String(ctx.data.perf.cache.hit),
            'x-perf-cache-misses': String(ctx.data.perf.cache.miss),
        },
    });`,
`    return conditionalResponse(ctx.request, html, {
        enable: isIndex,
        headers: {
            'content-type':  'text/html;charset=UTF-8',
            'cache-control': isIndex ? 'public, max-age=3600' : 'public, max-age=300',
            'server-timing': serverTiming,
            'x-cache-status': cacheStatus,
            'x-perf-cache-hits': String(ctx.data.perf.cache.hit),
            'x-perf-cache-misses': String(ctx.data.perf.cache.miss),
        },
    });`],
]);

await patch('functions/libros/[[path]].js', [
  ['import',
    "import { BASE, fetchActiveIndex, fetchCatalog } from '../_shared/catalog.js';",
    "import { BASE, fetchActiveIndex, fetchCatalog } from '../_shared/catalog.js';\nimport { conditionalResponse } from '../_shared/http-conditional.js';"],
  ['response',
`    return new Response(html, {
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });`,
`    return conditionalResponse(ctx.request, html, {
        enable: !hasUnexpectedParameters && items.length > 0,
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=3600',
        },
    });`],
]);

console.log('ETag/304 SSR patch applied');
