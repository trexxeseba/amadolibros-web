import { onRequest as catalog } from '../functions/catalogo.js';
import { onRequest as category } from '../functions/libros/[[path]].js';
import { onRequest as cover } from '../functions/book-cover/[[path]].js';
import { onRequest as immutable } from '../functions/preview-cover/[[path]].js';
import { COVER_INDEX_PREFIX } from '../functions/_shared/cover-public-index.js';
import { syncCoverMirror } from './cover-mirror.js';

const MANIFEST = 'covers/v1/manifest.json';
export default {
    async fetch(request, env, execution) {
        if (!env.INCIDENT_TOKEN || request.headers.get('authorization') !== `Bearer ${env.INCIDENT_TOKEN}`) {
            return new Response('Forbidden', { status: 403 });
        }
        if (!/^amado-cover-index-\d+-\d+$/.test(env.ACCEPTANCE_NAME || '')) return new Response('Invalid namespace', { status: 500 });
        // Only the temporary preview namespace has writes. No production put,
        // delete, metadata update, checkout or Merchant binding is exposed.
        const prefix = `acceptance/cover-index/${env.ACCEPTANCE_NAME}/`;
        const writable = env.ISOLATED_INDEX_PREVIEW;
        const url = new URL(request.url);
        if (url.pathname === '/ready' && request.method === 'GET') return Response.json({ head: env.INCIDENT_BUILD_SHA });
        if (url.pathname === '/cleanup' && request.method === 'DELETE') {
            let cursor;
            let deleted = 0;
            do {
                const page = await writable.list({ prefix, ...(cursor ? { cursor } : {}) });
                const keys = page.objects.map(row => row.key);
                if (keys.length) await writable.delete(keys);
                deleted += keys.length;
                cursor = page.truncated ? page.cursor : null;
            } while (cursor);
            return Response.json({ deleted, prefix, production_writes: 0 });
        }
        if (url.pathname === '/manifest' && request.method === 'GET') {
            const object = await env.PRODUCTION_COVERS_READONLY.get(MANIFEST);
            await writable.put(prefix + 'baseline.json', object.body, { customMetadata: { production_etag: object.etag } });
            const frozen = await writable.get(prefix + 'baseline.json');
            return new Response(frozen.body, { headers: { 'content-type': 'application/json', 'x-manifest-etag': object.etag } });
        }
        if (url.pathname === '/prepare' && request.method === 'POST') {
            const expected = request.headers.get('if-match');
            if (!expected) return new Response('Snapshot ETag required', { status: 400 });
            const object = await writable.get(prefix + 'baseline.json');
            if (!object?.body || object.customMetadata.production_etag !== expected) return new Response('Snapshot mismatch', { status: 409 });
            // Exercise the actual sync/CAS/bootstrap on the FULL original
            // manifest inside Cloudflare's resource limits, not a smaller
            // preprojected fixture. All its writes stay in this namespace.
            await writable.put(prefix + MANIFEST, object.body, { customMetadata: { production_etag: expected } });
            const isolated = {
                get: key => writable.get(prefix + key), head: key => writable.head(prefix + key),
                put: (key, body, options) => writable.put(prefix + key, body, options),
            };
            const result = await syncCoverMirror({ COVER_R2: isolated }, { items: [] }, {
                fetchFn: () => { throw new Error('Bootstrap must not fetch images'); },
            });
            return Response.json({ ...result.public_index, source_etag: expected, source_bytes: object.size,
                manifest_retries: result.manifest_retries, production_writes: 0 });
        }
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 });
        const started = performance.now();
        let manifestReads = 0;
        let bytes = 0;
        let heads = 0;
        const legacy = request.headers.get('x-acceptance-mode') === 'legacy';
        const reader = { async get(key) {
            let object;
            if (key === MANIFEST) {
                manifestReads++;
                // The comparison baseline is the original full production
                // body, pinned to the exact snapshot used to build the index.
                object = await writable.get(prefix + 'baseline.json');
                if (!object?.body) throw new Error('Acceptance snapshot missing');
            } else if (key.startsWith(COVER_INDEX_PREFIX)) object = await writable.get(prefix + key);
            else if (/^covers\/v1\/objects\/[a-f0-9]{64}\.(jpg|png|webp)$/.test(key)) object = await env.PRODUCTION_COVERS_READONLY.get(key);
            else throw new Error('Unexpected acceptance R2 key');
            bytes += object?.size || 0;
            return object;
        }, ...(!legacy ? { async head(key) {
            if (key !== MANIFEST) throw new Error('Unexpected acceptance HEAD');
            heads++;
            return writable.head(prefix + key);
        } } : {}) };
        // Unique cache origins provide a reproducible cold comparison without
        // purging or writing any production cache entry.
        const cacheId = request.headers.get('x-acceptance-cache-id');
        if (cacheId && /^[a-z0-9-]{1,63}$/.test(cacheId)) url.hostname = `${cacheId}.${env.ACCEPTANCE_NAME}.cover-acceptance.invalid`;
        const ctx = { request: new Request(url, request), data: {}, params: {}, waitUntil: p => execution.waitUntil(p),
            env: { APP_ENV: 'production', COVER_R2: reader, COVER_GOOGLE_QUALITY_GATE: 'true' } };
        let response;
        if (url.pathname === '/catalogo') response = await catalog(ctx);
        else if (url.pathname.startsWith('/libros/')) {
            ctx.params.path = url.pathname.slice('/libros/'.length).split('/');
            response = await category(ctx);
        } else if (url.pathname.startsWith('/book-cover/')) {
            ctx.params.path = url.pathname.slice('/book-cover/'.length).split('/');
            response = await cover(ctx);
        } else if (url.pathname.startsWith('/preview-cover/')) {
            ctx.params.path = url.pathname.slice('/preview-cover/'.length).split('/');
            response = await immutable(ctx);
        } else return new Response('Not found', { status: 404 });
        const headers = new Headers(response.headers);
        headers.set('x-incident-build', env.INCIDENT_BUILD_SHA);
        headers.set('x-incident-manifest-reads', String(manifestReads));
        headers.set('x-incident-r2-bytes', String(bytes));
        headers.set('x-incident-heads', String(heads));
        headers.set('x-incident-index-mode', ctx.data.coverIndex?.mode || 'not-used');
        headers.set('x-incident-index-reason', ctx.data.coverIndex?.reason || '');
        headers.set('x-incident-handler-ms', String(Math.round(performance.now() - started)));
        return new Response(response.body, { status: response.status, headers });
    },
};
