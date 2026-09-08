import acceptance from './cover-index-preview.js';
import { browserObserverScript } from './cover-scroll-observer.js';

const BASE = 'https://www.amadolibros.com';
const IMAGE_PATH = /^\/(?:book-cover\/MLU\d+\/cover(?:-(?:[2-9]|1[0-6]))?\.jpg|preview-cover\/MLU\d+\/(?:\d|1[0-5])\/[a-f0-9]{64}\.(?:jpg|png|webp))$/;

function internalRequest(request, env, pathname = null) {
    const url = new URL(request.url);
    if (pathname) { url.pathname = pathname; url.search = ''; }
    const headers = new Headers(request.headers);
    headers.set('authorization', `Bearer ${env.INCIDENT_TOKEN}`);
    headers.set('x-acceptance-mode', 'index');
    headers.delete('x-acceptance-cache-id');
    return new Request(url, { method: 'GET', headers });
}

function timingHeaders(response, transformMs = 0, cached = false) {
    const headers = new Headers(response.headers);
    const reads = cached ? 0 : Number(headers.get('x-incident-manifest-reads') || 0);
    const mode = cached ? 'variant-cache' : headers.get('x-incident-index-mode') || 'not-used';
    headers.set('server-timing', `cover_global_manifest;dur=${reads},cover_index;desc="${mode}",cover_transform;dur=${Math.round(transformMs)}`);
    headers.set('timing-allow-origin', '*');
    return headers;
}

export default {
    async fetch(request, env, execution) {
        // Existing authenticated preparation/check/cleanup API stays private.
        if (env.INCIDENT_TOKEN && request.headers.get('authorization') === `Bearer ${env.INCIDENT_TOKEN}`) {
            return acceptance.fetch(request, env, execution);
        }
        if (Date.now() > Number(env.SCROLL_EXPIRES_AT || 0)) return new Response('Preview expired', { status: 410 });
        if (!['GET', 'HEAD'].includes(request.method)) return new Response('Read only', { status: 405 });
        const url = new URL(request.url);
        const prefix = `acceptance/cover-index/${env.ACCEPTANCE_NAME}/`;
        if (url.pathname === '/scroll-ready') {
            const head = await env.ISOLATED_INDEX_PREVIEW.head(prefix + 'covers/v1/manifest.json');
            return Response.json({ head: env.INCIDENT_BUILD_SHA, root: head?.customMetadata?.cover_index_v1 || null,
                expires_at: new Date(Number(env.SCROLL_EXPIRES_AT)).toISOString() }, { headers: { 'x-robots-tag': 'noindex' } });
        }
        if (url.pathname.startsWith('/resize/')) {
            const match = /^\/resize\/([^/]+)(\/book-cover\/[^?]+)$/.exec(url.pathname);
            if (!match || !IMAGE_PATH.test(match[2])) return new Response('Not found', { status: 404 });
            const params = Object.fromEntries(match[1].split(',').map(value => value.split('=')));
            const width = Number(params.width);
            if (![240, 360, 480, 640, 720, 960, 1024].includes(width) || params.fit !== 'scale-down') {
                return new Response('Unsupported variant', { status: 400 });
            }
            const format = request.headers.get('accept')?.includes('image/avif') ? 'image/avif' : 'image/webp';
            const key = new Request(`${url.origin}${url.pathname}?format=${format}`);
            const cached = await caches.default.match(key);
            if (cached) return new Response(request.method === 'HEAD' ? null : cached.body,
                { status: cached.status, headers: timingHeaders(cached, 0, true) });
            const source = await acceptance.fetch(internalRequest(request, env, match[2]), env, execution);
            if (!source.ok) return source;
            const started = performance.now();
            const output = await env.IMAGES.input(source.body).transform({ width, fit: 'scale-down' })
                .output({ format, quality: 85 });
            const image = output.response();
            const headers = timingHeaders(source, performance.now() - started);
            headers.set('content-type', format);
            headers.set('x-cover-source-sha256', source.headers.get('etag') || '');
            headers.delete('etag');
            headers.delete('content-length');
            headers.set('cache-control', 'public, max-age=600');
            const response = new Response(image.body, { status: 200, headers });
            execution.waitUntil(caches.default.put(key, response.clone()));
            return request.method === 'HEAD' ? new Response(null, { status: 200, headers }) : response;
        }
        if (IMAGE_PATH.test(url.pathname)) {
            const response = await acceptance.fetch(internalRequest(request, env), env, execution);
            return new Response(request.method === 'HEAD' ? null : response.body,
                { status: response.status, headers: timingHeaders(response) });
        }
        if (!['/libros/psicologia', '/catalogo'].includes(url.pathname)) return new Response('Not found', { status: 404 });
        const response = await acceptance.fetch(internalRequest(request, env), env, execution);
        if (!response.ok) return response;
        const rewriteImage = value => value.replaceAll(`${BASE}/cdn-cgi/image/`, `${url.origin}/resize/`)
            .replaceAll(`${BASE}/book-cover/`, `${url.origin}/book-cover/`);
        const rewritten = new HTMLRewriter().on('img', { element(element) {
            for (const attribute of ['src', 'srcset']) {
                const value = element.getAttribute(attribute);
                if (!value) continue;
                element.setAttribute(attribute, value.startsWith('/assets/') ? `${BASE}${value}` : rewriteImage(value));
            }
        } }).on('script[src], link[rel="stylesheet"]', { element(element) {
            const attribute = element.tagName === 'script' ? 'src' : 'href';
            const value = element.getAttribute(attribute);
            if (value?.startsWith('/')) element.setAttribute(attribute, `${BASE}${value}`);
        } }).on('body', { element(element) {
            element.append(`<script>${browserObserverScript}</script>`, { html: true });
        } }).transform(response);
        const headers = new Headers(rewritten.headers);
        headers.set('cache-control', 'no-store');
        headers.set('x-robots-tag', 'noindex, nofollow');
        return new Response(rewritten.body, { status: rewritten.status, headers });
    },
};
