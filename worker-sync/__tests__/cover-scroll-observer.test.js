import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { browserObserverScript } from '../cover-scroll-observer.js';

async function assertBrowserEvidence(script) {
    let clock = 0;
    let intersectionCallback;
    let pre;
    let nextId = 0;
    const frames = new Map();
    const timers = new Map();
    const documentListeners = new Map();
    function makeImage(url, loaded = false) {
        const listeners = new Map();
        let resolveDecode;
        return {
            src: url, currentSrc: url, alt: url, loading: 'lazy', complete: loaded,
            naturalWidth: loaded ? 280 : 0, naturalHeight: loaded ? 373 : 0,
            getAttribute() { return null; },
            addEventListener(name, fn) { listeners.set(name, fn); },
            decode() { return new Promise(resolve => { resolveDecode = resolve; }); },
            fire(name) { listeners.get(name)?.(); },
            decoded() { resolveDecode(); },
        };
    }
    const images = [makeImage('https://qa.invalid/a'), makeImage('https://qa.invalid/b', true), makeImage('https://qa.invalid/c')];
    const document = {
        visibilityState: 'visible', getElementById() { return null; },
        querySelectorAll() { return images; },
        createElement(tag) {
            const node = { style: {}, append() {}, textContent: '' };
            if (tag === 'pre') pre = node;
            return node;
        },
        body: { append() {} },
        addEventListener(name, fn) { documentListeners.set(name, fn); },
    };
    const context = {
        document, innerWidth: 1000, innerHeight: 800, scrollY: 0,
        performance: { now: () => clock, timeOrigin: 100000, getEntriesByType: () => [], getEntriesByName: () => [] },
        requestAnimationFrame(fn) { frames.set(++nextId, fn); return nextId; },
        setTimeout(fn, delay) { timers.set(++nextId, { fn, at: clock + delay }); return nextId; },
        clearTimeout(id) { timers.delete(id); }, addEventListener() {},
        IntersectionObserver: class { constructor(fn) { intersectionCallback = fn; } observe() {} },
    };
    // Intentionally no __name or other bundle helper on the browser global.
    vm.runInNewContext(script, context);
    assert.equal(JSON.parse(pre.textContent).counts.never_entered_images, 3);
    async function flush(at) {
        clock = at;
        for (let i = 0; i < 10; i++) {
            await Promise.resolve();
            for (const [id, timer] of [...timers]) if (timer.at <= clock) {
                timers.delete(id); timer.fn();
            }
            for (const [id, fn] of [...frames]) { frames.delete(id); fn(); }
        }
    }
    function enter(img, at, visible = true) {
        clock = at;
        intersectionCallback([{ target: img, time: at, isIntersecting: visible,
            intersectionRect: { width: visible ? 280 : 0, height: visible ? 373 : 0 } }]);
    }
    await flush(0);
    clock = 5; images[1].decoded(); await flush(5);
    enter(images[0], 10); enter(images[1], 10);
    enter(images[0], 40, false);
    clock = 70;
    Object.assign(images[0], { complete: true, naturalWidth: 280, naturalHeight: 373 });
    images[0].fire('load'); await flush(70);
    clock = 80; images[0].decoded(); await flush(80);
    enter(images[0], 100); await flush(110);
    let evidence = JSON.parse(pre.textContent);
    assert.equal(evidence.images[0].sources[0].visible_blank_ms, 30);
    assert.equal(evidence.images[0].sources[0].visible_ms, 40);
    assert.equal(evidence.images[1].sources[0].verified_zero_blank, true);
    assert.equal(evidence.images[2].sources[0].visible_blank_ms, null);
    assert.equal(evidence.counts.never_entered_images, 1);
    clock = 120; document.visibilityState = 'hidden'; documentListeners.get('visibilitychange')();
    await flush(250);
    evidence = JSON.parse(pre.textContent);
    assert.equal(evidence.images[0].sources[0].visible_ms, 50);
    assert.equal(evidence.images[0].sources[0].visible_blank_ms, 30);
    assert.equal(Object.hasOwn(context, '__name'), false);
}

test('standalone observer produces evidence and accounts for real viewport intervals', async () => {
    await assertBrowserEvidence(browserObserverScript);
});

// The native suite runs before any npm install. validate-ci.sh explicitly runs
// this additional phase after Astro's locked npm ci; dependency failures must
// fail that phase rather than silently disabling the packaging regression test.
if (process.env.COVER_SCROLL_TEST_BUNDLE === 'true') {
    test('keepNames bundle produces standalone browser evidence and accounts for real viewport intervals', async () => {
        const { build } = await import('../../astro-front/node_modules/esbuild/lib/main.js');
        const bundle = await build({
            entryPoints: [new URL('../cover-scroll-observer.js', import.meta.url).pathname],
            bundle: true, write: false, format: 'esm', platform: 'browser', keepNames: true,
        });
        const { browserObserverScript: bundledScript } = await import('data:text/javascript;base64,' +
            Buffer.from(bundle.outputFiles[0].text).toString('base64'));
        // Exercise the actual helper calls injected by esbuild, not merely source JS.
        assert.match(bundledScript, /__name\(/);
        await assertBrowserEvidence(bundledScript);
    });
}
