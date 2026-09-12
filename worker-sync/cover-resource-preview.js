import { onRequest as catalog } from '../functions/catalogo.js';
import { onRequest as cover } from '../functions/book-cover/[[path]].js';
import { onRequest as immutable } from '../functions/preview-cover/[[path]].js';

// Temporary authenticated acceptance runner. Only GET/HEAD, no catalog/image
// writes and no payment/session bindings. The production image binding is
// exposed to the real handlers through an object with get() only.
export default {
    async fetch(request, env, execution) {
        if (!env.INCIDENT_TOKEN || request.headers.get('authorization') !== `Bearer ${env.INCIDENT_TOKEN}` ||
            !['GET', 'HEAD'].includes(request.method)) return new Response('Forbidden', { status: 403 });
        const url = new URL(request.url);
        if (url.pathname === '/ready') return Response.json({ head: env.INCIDENT_BUILD_SHA });
        if (url.pathname === '/manifest') {
            const object = await env.PRODUCTION_COVERS_READONLY.get('covers/v1/manifest.json');
            return new Response(object.body, { headers: { 'content-type': 'application/json',
                'x-manifest-etag': object.etag, 'x-manifest-size': String(object.size) } });
        }
        let manifestReads = 0;
        let bytes = 0;
        const readOnly = { async get(key) {
            if (key === 'covers/v1/manifest.json') manifestReads++;
            const object = await env.PRODUCTION_COVERS_READONLY.get(key);
            bytes += object?.size || 0;
            return object;
        } };
        const ctx = { request, data: {}, params: {}, waitUntil: p => execution.waitUntil(p),
            env: { APP_ENV: 'production', COVER_R2: readOnly, COVER_GOOGLE_QUALITY_GATE: 'true' } };
        let response;
        if (url.pathname === '/catalogo') response = await catalog(ctx);
        else if (url.pathname.startsWith('/book-cover/')) {
            ctx.params.path = url.pathname.slice('/book-cover/'.length).split('/');
            response = await cover(ctx);
        } else if (url.pathname.startsWith('/preview-cover/')) {
            ctx.params.path = url.pathname.slice('/preview-cover/'.length).split('/');
            response = await immutable(ctx);
        } else return new Response('Not found', { status: 404 });
        const selections = await Promise.all(new Set(ctx.data.__coverSelection?.products.values() || []));
        const headers = new Headers(response.headers);
        headers.set('x-incident-build', env.INCIDENT_BUILD_SHA);
        headers.set('x-incident-manifest-reads', String(manifestReads));
        headers.set('x-incident-r2-bytes', String(bytes));
        headers.set('x-incident-retained', String(selections.reduce((n, x) => n + (x?.read_stats?.entries_retained || 0), 0)));
        return new Response(response.body, { status: response.status, headers });
    },
};
