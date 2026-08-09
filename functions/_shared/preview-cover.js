const MANIFEST_KEY = 'covers/v1/manifest.json';
const OBJECT_KEY_RE = /^covers\/v1\/objects\/([a-f0-9]{64})\.(jpg|png|webp)$/;
const PRODUCT_ID_RE = /^MLU\d+$/;

function normalizeSourceUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    try {
        const url = new URL(raw.trim());
        if (url.hostname !== 'http2.mlstatic.com' ||
            !['http:', 'https:'].includes(url.protocol)) return null;
        url.protocol = 'https:';
        url.hash = '';
        return url.toString();
    } catch {
        return null;
    }
}

function validManifest(value) {
    return value && value.schema_version === 1 &&
        value.entries && typeof value.entries === 'object' &&
        !Array.isArray(value.entries);
}

async function readPreviewManifest(ctx) {
    if (!['preview', 'production'].includes(ctx?.env?.APP_ENV)) return null;
    const bucket = ctx?.env?.COVER_R2;
    if (!bucket || typeof bucket.get !== 'function') return null;
    if (!ctx.data || typeof ctx.data !== 'object') ctx.data = {};
    if (!ctx.data.__coverManifestPromise) {
        ctx.data.__coverManifestPromise = (async () => {
            try {
                const object = await bucket.get(MANIFEST_KEY);
                if (!object || typeof object.text !== 'function') return null;
                const parsed = JSON.parse(await object.text());
                return validManifest(parsed) ? parsed : null;
            } catch {
                return null;
            }
        })();
    }
    return ctx.data.__coverManifestPromise;
}

function validCurrent(entry) {
    const match = OBJECT_KEY_RE.exec(String(entry?.current?.object_key || ''));
    if (!match || entry.current.sha256 !== match[1]) return null;
    if (entry.current.mime !== `image/${match[2] === 'jpg' ? 'jpeg' : match[2]}`) return null;
    return {
        entry,
        objectKey: entry.current.object_key,
        sha256: match[1],
        extension: match[2],
        mime: entry.current.mime,
    };
}

export async function findPreviewCover(ctx, productId, position = 0, sourceUrl = null) {
    if (!PRODUCT_ID_RE.test(String(productId || '')) ||
        !Number.isInteger(position) || position < 0 || position > 15) return null;
    const manifest = await readPreviewManifest(ctx);
    const current = validCurrent(manifest?.entries?.[`${productId}:${position}`]);
    if (!current) return null;

    // Cuando el catálogo completo está disponible, exigimos que la copia
    // corresponda a la URL vigente de Mercado Libre. Los índices compactos
    // no conservan pictures[]; en ese caso sourceUrl=null y confiamos en el
    // manifest validado/refrescado por el piloto.
    if (sourceUrl !== null) {
        const normalized = normalizeSourceUrl(sourceUrl);
        if (!normalized || normalized !== current.entry.current.source_url) return null;
    }
    return current;
}

export async function previewCoverUrl(ctx, productId, position = 0, sourceUrl = null) {
    const cover = await findPreviewCover(ctx, productId, position, sourceUrl);
    if (!cover) return null;
    const origin = new URL(ctx.request.url).origin;
    return `${origin}/preview-cover/${productId}/${position}/${cover.sha256}.${cover.extension}`;
}

export async function previewCoverSummary(ctx) {
    const manifest = await readPreviewManifest(ctx);
    if (!manifest) return null;
    const covers = Object.values(manifest.entries)
        .map(validCurrent)
        .filter(Boolean);
    return {
        entries: Object.keys(manifest.entries).length,
        with_valid_copy: covers.length,
        sample_product_id: covers[0]?.entry?.product_id || null,
    };
}

export const PREVIEW_COVER_MANIFEST_KEY = MANIFEST_KEY;
