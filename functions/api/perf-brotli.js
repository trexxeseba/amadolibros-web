import { R2_BASE } from '../_shared/catalog.js';

const PROBE_URL = `${R2_BASE}/stock1-preview/probes/active-index.json.br`;
const MAX_COMPRESSED_BYTES = 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024;
const ITERATIONS = 5;

function elapsed(startedAt) {
    return Math.round((performance.now() - startedAt) * 100) / 100;
}

function stats(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return {
        min_ms: sorted[0],
        median_ms: sorted[Math.floor(sorted.length / 2)],
        max_ms: sorted.at(-1),
    };
}

async function decompressBrotli(bytes) {
    const stream = new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream('brotli'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function onRequestGet(ctx) {
    if (ctx?.env?.APP_ENV !== 'preview') {
        return new Response('Not found', { status: 404 });
    }

    const fetchStartedAt = performance.now();
    const response = await fetch(PROBE_URL, {
        headers: { 'Accept-Encoding': 'identity' },
        cf: { cacheEverything: true, cacheTtl: 31536000 },
    });
    const fetchMs = elapsed(fetchStartedAt);
    if (!response.ok) {
        return Response.json({
            compatible: false,
            stage: 'fetch',
            status: response.status,
        }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }

    const compressed = new Uint8Array(await response.arrayBuffer());
    if (compressed.byteLength === 0 || compressed.byteLength > MAX_COMPRESSED_BYTES) {
        return Response.json({
            compatible: false,
            stage: 'size',
            compressed_bytes: compressed.byteLength,
        }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
    }

    const decompressDurations = [];
    const parseDurations = [];
    let decompressed = null;
    let parsed = null;
    try {
        for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
            const decompressStartedAt = performance.now();
            decompressed = await decompressBrotli(compressed);
            decompressDurations.push(elapsed(decompressStartedAt));
            if (decompressed.byteLength > MAX_DECOMPRESSED_BYTES) {
                throw new Error('El resultado descomprimido excede el límite de la prueba.');
            }

            const parseStartedAt = performance.now();
            parsed = JSON.parse(new TextDecoder().decode(decompressed));
            parseDurations.push(elapsed(parseStartedAt));
        }
    } catch (error) {
        console.error(JSON.stringify({
            event: 'brotli_probe',
            compatible: false,
            error: String(error?.message || error).slice(0, 300),
        }));
        return Response.json({
            compatible: false,
            stage: 'decompress_or_parse',
            error: String(error?.message || error).slice(0, 300),
        }, { status: 501, headers: { 'Cache-Control': 'no-store' } });
    }

    const result = {
        compatible: parsed?.schema_version === 1 && Array.isArray(parsed?.items),
        format: 'brotli',
        iterations: ITERATIONS,
        compressed_bytes: compressed.byteLength,
        decompressed_bytes: decompressed.byteLength,
        item_count: Array.isArray(parsed?.items) ? parsed.items.length : null,
        fetch_ms: fetchMs,
        decompress: stats(decompressDurations),
        parse: stats(parseDurations),
    };
    console.log(JSON.stringify({ event: 'brotli_probe', ...result }));

    return Response.json(result, {
        status: result.compatible ? 200 : 422,
        headers: {
            'Cache-Control': 'no-store',
            'Server-Timing': [
                `probe_fetch;dur=${fetchMs}`,
                `probe_decompress;dur=${result.decompress.median_ms}`,
                `probe_parse;dur=${result.parse.median_ms}`,
            ].join(', '),
        },
    });
}
