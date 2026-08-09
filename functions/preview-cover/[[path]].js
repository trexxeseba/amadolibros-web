import {
    findPreviewCover,
    previewCoverSummary,
} from '../_shared/preview-cover.js';

function notFound() {
    return new Response('Not found', {
        status: 404,
        headers: { 'Cache-Control': 'no-store' },
    });
}

function pathParts(context) {
    return Array.isArray(context.params.path)
        ? context.params.path
        : [context.params.path].filter(Boolean);
}

export async function onRequest(context) {
    if (!['preview', 'production'].includes(context.env?.APP_ENV)) return notFound();
    if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
        return new Response('Method not allowed', {
            status: 405,
            headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
        });
    }

    const parts = pathParts(context);
    if (parts.length === 1 && parts[0] === 'status') {
        const summary = await previewCoverSummary(context);
        return summary
            ? Response.json(summary, { headers: { 'Cache-Control': 'no-store' } })
            : notFound();
    }

    if (parts.length !== 3) return notFound();
    const [productId, rawPosition, filename] = parts;
    const position = Number(rawPosition);
    const fileMatch = /^([a-f0-9]{64})\.(jpg|png|webp)$/.exec(filename || '');
    if (!fileMatch) return notFound();

    const cover = await findPreviewCover(context, productId, position);
    if (!cover || cover.sha256 !== fileMatch[1] || cover.extension !== fileMatch[2]) {
        return notFound();
    }

    try {
        const object = await context.env.COVER_R2.get(cover.objectKey);
        if (!object?.body) return notFound();
        const headers = new Headers({
            'Content-Type': cover.mime,
            'Cache-Control': 'public, max-age=31536000, immutable',
            'ETag': `"${cover.sha256}"`,
            'X-Content-Type-Options': 'nosniff',
            'X-Amado-Cover-Source': context.env.APP_ENV === 'production'
                ? 'r2-production'
                : 'r2-preview',
        });
        if (Number.isFinite(Number(object.size))) {
            headers.set('Content-Length', String(object.size));
        }
        return new Response(context.request.method === 'HEAD' ? null : object.body, {
            status: 200,
            headers,
        });
    } catch {
        return notFound();
    }
}
