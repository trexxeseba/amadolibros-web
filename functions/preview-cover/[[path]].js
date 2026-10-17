import { previewCoverSummary } from '../_shared/preview-cover.js';
import { imageVariant, readImageVariant } from '../../shared/image-variants.js';

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
    const variantId = new URL(context.request.url).searchParams.get('variant');
    if (variantId !== null && !imageVariant(variantId)) {
        return new Response('Invalid variant', { status: 400, headers: { 'Cache-Control': 'no-store' } });
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
    if (!fileMatch || !/^MLU\d+$/.test(productId) || !/^(?:[0-9]|1[0-5])$/.test(rawPosition) ||
        !Number.isInteger(position)) return notFound();
    // A content-addressed public URL already identifies its immutable object.
    // The mutable catalog pointer is consulted when generating URLs, not when
    // serving them. Previously every image decoded the entire mirror manifest.
    const sha256 = fileMatch[1];
    const extension = fileMatch[2];
    const objectKey = `covers/v1/objects/${sha256}.${extension}`;
    const mime = `image/${extension === 'jpg' ? 'jpeg' : extension}`;

    try {
        const derived = context.env.IMAGE_VARIANTS_READ_ENABLED === 'true' && variantId ? await readImageVariant(context.env.COVER_R2, sha256, variantId) : null;
        if (variantId && !derived) console.warn(JSON.stringify({event:'card-variant-fallback', recipe:variantId, bucket:context.env.COVER_R2_BUCKET_NAME || 'unspecified'}));
        const object = derived || await context.env.COVER_R2.get(objectKey);
        if (!object?.body) return notFound();
        const headers = new Headers({
            'Content-Type': derived ? 'image/webp' : mime,
            'Cache-Control': variantId && !derived ? 'public, max-age=300' : 'public, max-age=31536000, immutable',
            'ETag': `"${derived ? derived.customMetadata.sha256 : sha256}"`,
            'X-Content-Type-Options': 'nosniff',
            'X-Amado-Cover-Source': context.env.APP_ENV === 'production'
                ? 'r2-production'
                : 'r2-preview',
        });
        if (variantId) headers.set('X-Cover-Variant', derived ? variantId : 'original-fallback');
        if (derived) {
            headers.set('X-Cover-Source', 'r2-variant');
            headers.set('X-Cover-Index', 'content-addressed');
            if (context.env.COVER_R2_BUCKET_NAME) headers.set('X-Cover-Bucket', context.env.COVER_R2_BUCKET_NAME);
        }
        if (Number.isFinite(Number(object.size))) {
            headers.set('Content-Length', String(object.size));
        }
        return new Response(context.request.method === 'HEAD' ? null : object.body, {
            status: 200,
            headers,
        });
    } catch {
        console.warn(JSON.stringify({event:'cover-storage-unavailable',variant:Boolean(variantId)}));
        return new Response('Image temporarily unavailable', {status:503,headers:{'Cache-Control':'no-store','Retry-After':'5'}});
    }
}
