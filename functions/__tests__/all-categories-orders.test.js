import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../libros/[[path]].js';
import { SEO_CATEGORIES } from '../_shared/seo-categories.js';
import { R2_BASE, PRODUCTION_MANIFEST_URL, PAUSED_MANIFEST_URL } from '../_shared/catalog.js';

const cardIds = html => [...html.matchAll(/class="book-image" href="[^"]*\/libro\/(MLU\d+)\//g)].map(m => m[1]);

// Las colecciones de tarot tienen su propia suite de formatos. Estas pruebas
// cubren todas las demás landings con los índices compactos de cada entorno.
for (const category of SEO_CATEGORIES.filter(c => !c.tarotFilter)) {
    for (const appEnv of ['production', 'preview']) {
        test(`${category.id} (${appEnv}): conserva ambos estados, ediciones y paginación`, async () => {
            const active = Array.from({ length: 26 }, (_, i) => [
                `MLU${10000 + i}`, `Disponible ${String(i).padStart(2, '0')}`, 'Autor', String(9780000000000 + i), '', 1000 + i, 1,
            ]);
            const paused = Array.from({ length: 26 }, (_, i) => [
                `MLU${20000 + i}`, `Encargo ${String(i).padStart(2, '0')}`, 'Autor', String(9781000000000 + i), '',
            ]);
            // La publicación con stock gana ante ID repetido o misma edición.
            const duplicates = [active[0].slice(0, 5), ['MLU30000', 'Edición repetida', 'Autor', active[1][3], '']];
            const classification = (category.classificationIds || [category.classificationId || category.id])[0];
            const paths = Object.fromEntries([...active, ...paused, ...duplicates].map(row => [row[0], [classification]]));
            paths.MLU99999 = ['categoria-ajena'];
            const manifest = appEnv === 'production' ? PRODUCTION_MANIFEST_URL : PAUSED_MANIFEST_URL;
            globalThis.caches = { default: {
                async match(request) {
                    if (request.url.endsWith('/data/active-categories.json')) return Response.json({ categories: [], items: paths });
                    if (request.url === manifest) return Response.json({ schema_version: 1, current: {
                        version: 'all-categories', index_key: 'all-categories/index.json', active_index_key: 'all-categories/active-index.json', block_prefix: 'all-categories', block_count: 128,
                    } });
                    if (request.url === `${R2_BASE}/all-categories/active-index.json`) return Response.json({ schema_version: 1,
                        fields: ['id', 'title', 'author', 'isbn', 'image', 'price', 'available_quantity'],
                        derived_fields: { slug: 'slugify-v1', status: 'active' }, items: active,
                    });
                    if (request.url === `${R2_BASE}/all-categories/index.json`) return Response.json({ schema_version: 1,
                        fields: ['id', 'title', 'author', 'isbn', 'image'], block_count: 128,
                        derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
                        items: [...paused, ...duplicates, ['MLU99999', 'No pertenece', 'Autor', '', '']],
                    });
                    assert.fail(`No debe leer el catálogo completo ni otro entorno: ${request.url}`);
                }, async put() {},
            } };
            const pageSize = category.id.startsWith('biblias') ? 24 : 48;
            const displayed = [];
            for (let page = 1; page <= Math.ceil(52 / pageSize); page++) {
                const host = appEnv === 'production' ? 'www.amadolibros.com' : 'preview.example';
                const response = await onRequest({
                    request: new Request(`https://${host}/libros/${category.id}${page > 1 ? `?page=${page}` : ''}`),
                    params: { path: category.id.split('/') }, env: { APP_ENV: appEnv }, data: {}, waitUntil() {},
                });
                assert.equal(response.status, 200);
                const html = await response.text();
                const ids = cardIds(html);
                displayed.push(...ids);
                assert.equal(ids.length, Math.min(pageSize, 52 - (page - 1) * pageSize));
                assert.equal((html.match(/class="stock-badge by-request"/g) || []).length, ids.length / 2);
                assert.equal((html.match(/aria-label="Te llega hoy en Montevideo"/g) || []).length, ids.length / 2);
                assert.match(html, /26 disponibles · 26 por encargo/);
                assert.match(html, /<form class="category-order"/);
                assert.match(html, /Consultá precio y plazo de entrega/);
                assert.doesNotMatch(html, /Libros disponibles<\/h2>|No pertenece|Edición repetida/);
                assert.ok(html.includes(`content="${appEnv === 'production' ? 'index, follow' : 'noindex, follow'}"`));
            }
            assert.equal(new Set(displayed).size, 52);
            assert.deepEqual(displayed, active.flatMap((row, i) => [row[0], paused[i][0]]));
        });
    }
}
