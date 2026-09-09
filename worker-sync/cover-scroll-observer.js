// Insert at the end of the isolated QA page only. No requests, storage, scrolling,
// or image attribute changes: the rendered <pre> is the complete evidence API.
function observeCoverScroll() {
    if (document.getElementById('cover-scroll-evidence')) return;
    const startedAt = performance.now();
    const maxImages = 48;
    const maxSourcesPerImage = 4;
    const allImages = Array.from(document.querySelectorAll('article img'));
    const details = document.createElement('details');
    details.id = 'cover-scroll-evidence';
    details.style.cssText = 'margin:24px;padding:12px;border:1px solid #777;background:#fff;color:#111;text-align:left;font:12px/1.5 monospace;';
    const summary = document.createElement('summary');
    const pre = document.createElement('pre');
    pre.style.cssText = 'max-height:65vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;';
    details.append(summary, pre);
    document.body.append(details);

    let frame = null;
    let timer = null;
    let refreshTimer = null;
    let lastRenderedAt = -Infinity;
    let observer = null;
    const items = [];
    const round = value => value === null ? null : Math.round(value * 10) / 10;
    const pageVisible = () => document.visibilityState === 'visible';
    const sourceURL = img => img.currentSrc || img.src;
    const isLoaded = img => img.complete && img.naturalWidth > 0 && img.naturalHeight > 0;
    const blankInInterval = (record, start, end) =>
        Math.max(0, Math.min(end, record.decodedAt === null ? end : record.decodedAt) - start);

    function closeInterval(record, at) {
        if (record.openAt === null) return;
        const end = Math.max(record.openAt, at);
        record.visibleMs += end - record.openAt;
        record.blankMs += blankInInterval(record, record.openAt, end);
        record.openAt = null;
    }

    function openInterval(record, at) {
        if (record.openAt !== null) return;
        record.openAt = at;
        record.intervals++;
        if (record.firstEnter === null) {
            record.firstEnter = at;
            record.loadedWhenEntered = record.loadedAt !== null && record.loadedAt <= at;
            record.decodedWhenEntered = record.decodedAt !== null && record.decodedAt <= at;
        }
    }

    function checkDecode(item, record, at) {
        const img = item.img;
        if (!isLoaded(img)) return;
        record.naturalWidth = img.naturalWidth;
        record.naturalHeight = img.naturalHeight;
        if (record.loadedAt === null) record.loadedAt = at;
        if (record.decodeStatus !== 'not-started') return;
        if (typeof img.decode !== 'function') {
            record.decodeStatus = 'unavailable';
            return;
        }
        // Only decode an image that the browser has already loaded. Calling
        // decode() on an unloaded lazy image could change the behavior under test.
        record.decodeStatus = 'pending';
        Promise.resolve().then(() => {
            if (item.active !== record || sourceURL(img) !== record.url) {
                throw new Error('Source changed before decode');
            }
            return img.decode();
        }).then(() => {
            if (item.active !== record || sourceURL(img) !== record.url) {
                throw new Error('Source changed during decode');
            }
            record.decodedAt = performance.now();
            record.decodeStatus = 'resolved';
            schedule();
        }).catch(error => {
            record.decodeStatus = 'rejected';
            record.decodeError = String(error && error.message || error).slice(0, 200);
            schedule();
        });
    }

    function syncSource(item, at) {
        const img = item.img;
        const url = sourceURL(img);
        let record = item.active;
        // Before selection, currentSrc is empty for a lazy responsive image.
        // Bind that initial record to the selected URL without inventing a
        // separate request for the fallback src attribute.
        if (record && !record.selected && img.currentSrc) {
            record.url = url;
            record.selected = true;
        } else if (record && record.url !== url) {
            closeInterval(record, at);
            record.endedAt = at;
            item.active = record = null;
        }
        if (!record) {
            if (item.records.length >= maxSourcesPerImage) {
                item.sourceLimitReached = true;
                return null;
            }
            record = {
                url, selected: Boolean(img.currentSrc), sourceObservedAt: at,
                endedAt: null, firstEnter: null, loadedWhenEntered: null,
                decodedWhenEntered: null, loadedAt: isLoaded(img) ? at : null,
                decodedAt: null, decodeStatus: 'not-started', decodeError: null,
                error: false, errorAt: null, naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight, visibleMs: 0, blankMs: 0,
                openAt: null, intervals: 0,
                source: { src: img.src, srcset: img.getAttribute('srcset'), sizes: img.getAttribute('sizes') },
                loading: img.loading || 'eager',
            };
            item.records.push(record);
            item.active = record;
            if (item.inViewport && pageVisible()) openInterval(record, at);
        }
        checkDecode(item, record, at);
        return record;
    }

    function processIntersections(entries) {
        const now = performance.now();
        for (const entry of entries) {
            const item = items.find(candidate => candidate.img === entry.target);
            if (!item) continue;
            const record = syncSource(item, now);
            item.inViewport = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
            if (!record) continue;
            const at = Math.max(record.sourceObservedAt, entry.time);
            if (item.inViewport && pageVisible()) openInterval(record, at);
            else closeInterval(record, at);
        }
        schedule();
    }

    function serverTiming(entry) {
        return Array.from(entry.serverTiming || [], timing => ({
            name: timing.name, duration_ms: round(timing.duration), description: timing.description,
        }));
    }

    function timingEvidence(entry) {
        const timings = serverTiming(entry);
        return {
            name: entry.name, initiator_type: entry.initiatorType || entry.entryType,
            start_time: round(entry.startTime), duration_ms: round(entry.duration),
            request_start: round(entry.requestStart), response_start: round(entry.responseStart),
            response_end: round(entry.responseEnd), transfer_size: entry.transferSize,
            encoded_body_size: entry.encodedBodySize, decoded_body_size: entry.decodedBodySize,
            response_status: entry.responseStatus === undefined ? null : entry.responseStatus,
            server_timing: timings,
            cover_global_manifest: timings.filter(timing => timing.name === 'cover_global_manifest'),
            cover_index: timings.filter(timing => timing.name === 'cover_index'),
        };
    }

    function render() {
        frame = null;
        const now = performance.now();
        lastRenderedAt = now;
        const images = items.map(item => {
            syncSource(item, now);
            return {
                image_index: item.index, alt: item.img.alt,
                in_viewport: item.inViewport, source_limit_reached: item.sourceLimitReached,
                sources: item.records.map(record => {
                    const entered = record.firstEnter !== null;
                    const openVisible = record.openAt === null ? 0 : Math.max(0, now - record.openAt);
                    const blank = record.blankMs + (record.openAt === null ? 0 : blankInInterval(record, record.openAt, now));
                    return {
                        url: record.url, browser_selected_url: record.selected,
                        source: record.source, loading: record.loading,
                        first_enter_time: round(record.firstEnter),
                        loaded_when_entered: record.loadedWhenEntered,
                        decoded_when_entered: record.decodedWhenEntered,
                        viewport_intervals: record.intervals,
                        visible_ms: entered ? round(record.visibleMs + openVisible) : null,
                        visible_blank_ms: entered ? round(blank) : null,
                        visible_blank_pending: entered && record.decodedAt === null && !record.error,
                        verified_zero_blank: entered && blank === 0 && record.decodedAt !== null,
                        currently_visible: record.openAt !== null,
                        loaded_time: round(record.loadedAt), decoded_time: round(record.decodedAt),
                        decode_status: record.decodeStatus, decode_error: record.decodeError,
                        error: record.error, error_time: round(record.errorAt),
                        natural_width: record.naturalWidth, natural_height: record.naturalHeight,
                        source_observed_time: round(record.sourceObservedAt), source_ended_time: round(record.endedAt),
                        resource_timings: performance.getEntriesByName(record.url, 'resource').slice(-4).map(timingEvidence),
                    };
                }),
            };
        });
        const sources = images.flatMap(img => img.sources);
        const enteredImages = images.filter(img => img.sources.some(source => source.first_enter_time !== null));
        const enteredSources = sources.filter(source => source.first_enter_time !== null);
        const counts = {
            total_article_images: allImages.length, observed_images: items.length,
            entered_images: enteredImages.length, never_entered_images: items.length - enteredImages.length,
            currently_visible_images: images.filter(img => img.sources.some(source => source.currently_visible)).length,
            entered_sources: enteredSources.length,
            loaded_when_entered: enteredSources.filter(source => source.loaded_when_entered).length,
            not_loaded_when_entered: enteredSources.filter(source => source.loaded_when_entered === false).length,
            verified_zero_blank: enteredSources.filter(source => source.verified_zero_blank).length,
            positive_visible_blank: enteredSources.filter(source => source.visible_blank_ms > 0).length,
            pending_readiness: enteredSources.filter(source => source.visible_blank_pending).length,
            image_errors: sources.filter(source => source.error).length,
            decode_errors: sources.filter(source => source.decode_status === 'rejected').length,
        };
        summary.textContent = `Cover scroll evidence: ${counts.entered_images}/${counts.observed_images} images entered; ${counts.positive_visible_blank} with measured readiness delay`;
        pre.textContent = JSON.stringify({
            schema: 'cover-scroll-observer-v1', observer_started_time: round(startedAt),
            measured_at_time: round(now), time_origin: performance.timeOrigin,
            document_visibility: document.visibilityState,
            viewport: { width: innerWidth, height: innerHeight, scroll_y: scrollY },
            intersection_observer_supported: Boolean(observer), counts,
            method: 'Milliseconds use performance.now(). Visible blank is viewport exposure before decode() resolves; intervals outside the viewport or while the document is hidden are excluded. Never-entered images have null measurements.',
            limitations: [
                'Decode readiness is a conservative proxy, not proof of compositor paint, an empty pixel region, visual cover correctness, or absence of an overlay.',
                'Observation begins at script execution; earlier load/paint history and already-failed image requests are not recoverable. A previously completed image is decoded again for confirmation.',
                'IntersectionObserver delivery, load callbacks, and source-change detection have scheduling uncertainty. Current sources are checked on observation, scroll, resize, and load events.',
                'Only the first 48 article images and up to four selected sources per image are observed. Source changes close the prior source interval when detected.',
                'Resource timing may be absent or redacted because of cache behavior, timing buffer limits, or cross-origin timing permissions. A missing server timing entry is not zero reads.',
                'Image errors count observed error events only; complete=true with zero natural dimensions is not by itself a confirmed error.',
            ],
            navigation: performance.getEntriesByType('navigation').slice(0, 1).map(timingEvidence),
            images,
        }, null, 2);
        clearTimeout(timer);
        timer = null;
        if (pageVisible() && sources.some(source => source.currently_visible && source.decoded_time === null)) {
            timer = setTimeout(schedule, 250);
        }
    }

    function schedule() {
        if (frame !== null || refreshTimer !== null) return;
        const delay = 100 - (performance.now() - lastRenderedAt);
        if (delay > 0) {
            refreshTimer = setTimeout(() => { refreshTimer = null; schedule(); }, delay);
        } else frame = requestAnimationFrame(render);
    }

    for (const [index, img] of allImages.slice(0, maxImages).entries()) {
        const item = { img, index, inViewport: false, records: [], active: null, sourceLimitReached: false };
        items.push(item);
        syncSource(item, startedAt);
        img.addEventListener('load', () => { syncSource(item, performance.now()); schedule(); });
        img.addEventListener('error', () => {
            const now = performance.now();
            const record = syncSource(item, now);
            if (record) { record.error = true; record.errorAt = now; }
            schedule();
        });
    }
    if (typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver(processIntersections, { root: null, rootMargin: '0px', threshold: [0, 0.000001] });
        items.forEach(item => observer.observe(item.img));
    }
    document.addEventListener('visibilitychange', () => {
        const now = performance.now();
        for (const item of items) {
            if (!item.active) continue;
            if (pageVisible() && item.inViewport) openInterval(item.active, now);
            else closeInterval(item.active, now);
        }
        schedule();
    });
    addEventListener('scroll', schedule, { passive: true });
    addEventListener('resize', schedule, { passive: true });
    addEventListener('load', schedule, { once: true });
    render();
}

// Wrangler/esbuild keepNames inserts __name() calls inside this function.
// Function.toString() does not carry the bundle's helper into the browser, so
// provide its equivalent inside the injected script's own lexical scope.
export const browserObserverScript = `(() => {
    const __name = (target, value) => Object.defineProperty(target, 'name', { value, configurable: true });
    (${observeCoverScroll.toString()})();
})();`;
