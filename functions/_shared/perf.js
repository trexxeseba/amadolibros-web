const SERVER_TIMING_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/;

function finiteMilliseconds(value) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0
        ? Math.round(number * 100) / 100
        : null;
}

export function perfNow() {
    return performance.now();
}

export function ensurePerf(ctx) {
    if (!ctx.data || typeof ctx.data !== 'object') ctx.data = {};
    if (!ctx.data.perf || typeof ctx.data.perf !== 'object') {
        ctx.data.perf = {
            started_at: perfNow(),
            segments: [],
            cache: { hit: 0, miss: 0 },
        };
    }
    return ctx.data.perf;
}

export function recordPerf(ctx, name, startedAt, detail = {}) {
    if (!SERVER_TIMING_TOKEN.test(name)) return null;
    const duration_ms = finiteMilliseconds(perfNow() - startedAt);
    if (duration_ms == null) return null;
    const perf = ensurePerf(ctx);
    perf.segments.push({ name, duration_ms, ...detail });
    if (detail.cache === 'hit') perf.cache.hit += 1;
    if (detail.cache === 'miss') perf.cache.miss += 1;
    return duration_ms;
}

export function serverTimingValue(ctx, extra = []) {
    const perf = ensurePerf(ctx);
    const segments = [...perf.segments, ...extra]
        .map(segment => ({
            name: segment.name,
            duration_ms: finiteMilliseconds(segment.duration_ms),
        }))
        .filter(segment => SERVER_TIMING_TOKEN.test(segment.name) && segment.duration_ms != null);
    return segments.map(segment => `${segment.name};dur=${segment.duration_ms}`).join(', ');
}

export function perfSummary(ctx, extra = {}) {
    const perf = ensurePerf(ctx);
    return {
        event: 'catalog_search_perf',
        app_env: ctx?.env?.APP_ENV || 'unknown',
        cache_hits: perf.cache.hit,
        cache_misses: perf.cache.miss,
        segments: perf.segments,
        ...extra,
    };
}
