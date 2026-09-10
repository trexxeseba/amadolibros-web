import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { prepareCoverIndex, readCoverIndex, COVER_INDEX_METADATA } from '../functions/_shared/cover-public-index.js';
import { isDeepStrictEqual } from 'node:util';
import { isEligibleForFeed, dedupeByGtinAndCondition, filterItemsWithReadyPrimaryCover, renderFeedItem } from '../functions/feed.xml.js';
import { coverManifestBudget, coverBudgetMessage } from '../functions/_shared/cover-manifest-budget.js';

const base = process.env.INCIDENT_URL;
const token = process.env.INCIDENT_TOKEN;
const head = process.env.INCIDENT_BUILD_SHA;
const output = 'artifacts/cover-index';
const screenshotIds = ['MLU1094451174', 'MLU634431651', 'MLU709390092', 'MLU690771648', 'MLU679987262'];
const report = { head, observed_at: new Date().toISOString(), production_writes: 0, pages: [], images: [], comparison: [], failures: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function request(path, options = {}) {
    return fetch(new URL(path, base), { ...options, headers: { authorization: `Bearer ${token}`, ...options.headers }, signal: AbortSignal.timeout(120_000) });
}
function metrics(response) {
    return { status: response.status, manifest_reads: Number(response.headers.get('x-incident-manifest-reads')),
        r2_bytes: Number(response.headers.get('x-incident-r2-bytes')), heads: Number(response.headers.get('x-incident-heads')),
        index_mode: response.headers.get('x-incident-index-mode'), fallback_reason: response.headers.get('x-incident-index-reason'),
        handler_ms: Number(response.headers.get('x-incident-handler-ms')), public_index_header: response.headers.get('x-cover-index'),
        deployed_head: response.headers.get('x-incident-build') };
}
async function imageCheck(path, { mode = 'index', cold = null, expected = null } = {}) {
    const started = Date.now();
    const response = await request(path, { headers: { 'x-acceptance-mode': mode, ...(cold ? { 'x-acceptance-cache-id': cold } : {}) } });
    const bytes = Buffer.from(await response.arrayBuffer());
    const digest = hash(bytes);
    const immutable = path.startsWith('/preview-cover/');
    expected ||= immutable ? /\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(path)?.[1] : response.headers.get('etag')?.replaceAll('"', '');
    const row = { path, mode, cold: Boolean(cold), ...metrics(response), sha256: digest, expected_sha256: expected,
        bytes: bytes.length, ms: Date.now() - started, source: response.headers.get('x-cover-source') || response.headers.get('x-amado-cover-source') };
    row.ok = response.ok && row.deployed_head === head && bytes.length > 0 && digest === expected &&
        response.headers.get('content-type')?.startsWith('image/') && row.source === 'r2-production' &&
        (mode === 'legacy' ? row.manifest_reads === 1 && row.public_index_header === 'legacy-fallback' :
            row.manifest_reads === 0 && (immutable || row.index_mode === 'public-index' && row.public_index_header === 'public-index'));
    report.images.push(row);
    if (!row.ok) report.failures.push(`Image failed: ${path} (${mode}), HTTP ${response.status}, ${row.index_mode}/${row.fallback_reason}`);
    return row;
}
try {
    await mkdir(output, { recursive: true });
    let ready = false;
    for (let n = 0; n < 12 && !ready; n++) {
        const response = await request('/ready').catch(() => null);
        ready = Boolean(response?.ok && (await response.json()).head === head);
        if (!ready) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!ready) throw new Error('Temporary worker is not on requested head');
    const manifestResponse = await request('/manifest');
    if (!manifestResponse.ok) throw new Error(`Snapshot HTTP ${manifestResponse.status}`);
    const raw = Buffer.from(await manifestResponse.arrayBuffer());
    const original = JSON.parse(raw.toString('utf8'));
    const etag = manifestResponse.headers.get('x-manifest-etag');
    await writeFile(`${output}/manifest-snapshot.json.gz`, gzipSync(raw));

    // Cuánto aire le queda al escritor antes del 1102. El manifest entero vive
    // en memoria mientras el cron lo reescribe, y el isolate tiene 128 MB.
    // Esto no lo arregla: avisa con meses, que es lo que no teníamos.
    //
    // Va acá arriba a propósito, apenas se tiene el manifest y antes de
    // cualquier cosa que pueda tirar: si el chequeo se cae por otro motivo,
    // el presupuesto se informa igual. Es justo cuando más se quiere ver.
    report.budget = coverManifestBudget({ manifestBytes: raw.length,
        entries: Object.keys(original.entries).length });
    console.log(coverBudgetMessage(report.budget));
    if (report.budget.level === 'critical') {
        report.failures.push(`Presupuesto de memoria del escritor de portadas: ${coverBudgetMessage(report.budget)}`);
    }

    report.preparations = [];
    // Both full-snapshot preparations must pass. This is a repeated-write
    // resource check, not a retry that could hide a failed first attempt.
    for (let pass = 1; pass <= 2; pass++) {
        const preparation = await request('/prepare', { method: 'POST', headers: { 'if-match': etag,
            ...(pass === 2 ? { 'x-acceptance-conflict-once': 'true' } : {}) } });
        if (!preparation.ok) throw new Error(`Index preparation ${pass}/2 HTTP ${preparation.status}: ${await preparation.text()}`);
        const index = await preparation.json();
        if (index.injected_conditional_checks !== pass - 1 ||
            index.conditional_conflicts + index.conditional_transport_errors !== pass - 1 ||
            index.manifest_transport_retries !== index.conditional_transport_errors || index.manifest_retries !== pass - 1) {
            throw new Error('Full snapshot did not exercise the expected native conditional-write retry');
        }
        if (report.index && report.index.hash !== index.hash) throw new Error('Repeated snapshot preparation changed the public index');
        report.preparations.push(index);
        report.index = index;
    }
    const writtenResponse = await request('/written-manifest');
    if (!writtenResponse.ok) throw new Error(`Written manifest HTTP ${writtenResponse.status}`);
    const written = await writtenResponse.json();
    report.full_manifest_preserved = isDeepStrictEqual({ ...written, updated_at: original.updated_at }, original);
    const previousTime = Date.parse(original.updated_at), writtenTime = Date.parse(written.updated_at);
    if (!report.full_manifest_preserved || !Number.isFinite(previousTime) || !Number.isFinite(writtenTime) || writtenTime < previousTime) {
        throw new Error('Full manifest rewrite lost data or moved updated_at backwards');
    }

    // Independently reconstruct and read every shard, not only the sample.
    // Its hash must equal the tree actually generated inside Cloudflare.
    const memory = new Map();
    const bucket = { put: async (key, body) => { memory.set(key, body); return {}; },
        get: async key => memory.has(key) ? { text: async () => memory.get(key) } : null,
        head: async () => ({ customMetadata: { [COVER_INDEX_METADATA]: report.index.hash } }) };
    const expectedIndex = await prepareCoverIndex(bucket, original);
    if (expectedIndex.hash !== report.index.hash) throw new Error('Cloudflare index differs from full original snapshot projection');
    const projected = await readCoverIndex(bucket, [...new Set(Object.keys(original.entries).map(key => key.split(':')[0]))]);
    const catalogResponse = await fetch('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json');
    if (!catalogResponse.ok) throw new Error(`Catalog HTTP ${catalogResponse.status}`);
    const catalog = await catalogResponse.json();
    const eligible = catalog.items.filter(isEligibleForFeed);
    const feed = manifest => dedupeByGtinAndCondition(filterItemsWithReadyPrimaryCover(eligible, manifest, true));
    const oldFeed = feed(original);
    const newFeed = feed(projected);
    const xml = (items, manifest) => items.map(item => renderFeedItem(item, manifest, null, true)).join('');
    const oldXml = xml(oldFeed, original), newXml = xml(newFeed, projected);
    report.snapshot = { catalog_updated_at: catalog.updated_at, manifest_etag: etag, manifest_bytes: raw.length,
        manifest_sha256: hash(raw), original_entries: Object.keys(original.entries).length, indexed_entries: Object.keys(projected.entries).length,
        old_feed_items: oldFeed.length, new_feed_items: newFeed.length, old_item_xml_sha256: hash(oldXml), new_item_xml_sha256: hash(newXml) };
    if (oldFeed.length === 0 || oldXml !== newXml || report.snapshot.original_entries !== report.snapshot.indexed_entries) {
        throw new Error('Full index lost entries or changed Merchant XML');
    }
    for (const [index, id] of screenshotIds.entries()) {
        const current = original.entries[`${id}:0`]?.current;
        if (!current?.sha256) throw new Error(`Screenshot image absent from snapshot: ${id}`);
        const path = `/book-cover/${id}/cover.jpg`;
        const before = await imageCheck(path, { mode: 'legacy', cold: `before-${index}`, expected: current.sha256 });
        const after = await imageCheck(path, { mode: 'index', cold: `after-${index}`, expected: current.sha256 });
        report.comparison.push({ id, before_handler_ms: before.handler_ms, after_handler_ms: after.handler_ms,
            before_r2_bytes: before.r2_bytes, after_r2_bytes: after.r2_bytes, identical_bytes: before.sha256 === after.sha256 });
    }

    const paths = new Set();
    for (const page of ['/catalogo', '/catalogo?page=2', '/catalogo?disponibilidad=disponibles', '/libros/psicologia']) {
        const started = Date.now();
        const response = await request(page, { headers: { 'x-acceptance-cache-id': `page-${report.pages.length}` } });
        const html = await response.text();
        const images = [...new Set([...html.matchAll(/\/(?:preview-cover\/MLU\d+\/(?:[0-9]|1[0-5])\/[a-f0-9]{64}\.(?:jpg|png|webp)|book-cover\/MLU\d+\/cover(?:-\d+)?\.jpg)/g)].map(x => x[0]))];
        images.forEach(path => paths.add(path));
        const row = { path: page, ...metrics(response), images: images.length, ms: Date.now() - started,
            category_asset_sha256: response.headers.get('x-incident-category-sha256') };
        row.ok = response.ok && row.deployed_head === head && images.length >= 40 && row.manifest_reads === 0 &&
            (page.startsWith('/catalogo') ? row.index_mode === 'public-index' : row.index_mode !== 'legacy-fallback');
        report.pages.push(row);
        if (!row.ok) report.failures.push(`Page failed: ${page}, HTTP ${response.status}, images=${images.length}, ${row.index_mode}`);
        await writeFile(`${output}/page-${report.pages.length}.html`, html);
    }
    const remaining = [...paths];
    await Promise.all(Array.from({ length: 3 }, async () => {
        while (remaining.length) await imageCheck(remaining.shift());
    }));
    const before = median(report.comparison.map(row => row.before_handler_ms));
    const after = median(report.comparison.map(row => row.after_handler_ms));
    report.performance = { scope: 'Authenticated Cloudflare Worker, unique cold cache origins, same frozen snapshot; not a Uruguay browser measurement',
        before_median_handler_ms: before, after_median_handler_ms: after, reduction_percent: Number((100 * (1 - after / before)).toFixed(2)) };
    if (after >= before * 0.5 || after >= 1500) report.failures.push('Cold median did not improve at least 50% and fall below 1500ms');
} catch (error) {
    report.failures.push(error.stack || error.message);
    const state = await request('/index-state').catch(() => null);
    report.preparation_state = state?.ok ? await state.json() : { unavailable: true, status: state?.status || null };
} finally {
    report.completed_at = new Date().toISOString();
    report.summary = { pages: report.pages.length, pages_ok: report.pages.filter(row => row.ok).length,
        images: report.images.length, images_ok: report.images.filter(row => row.ok).length, failures: report.failures.length };
    await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ snapshot: report.snapshot, budget: report.budget, index: report.index, summary: report.summary,
        performance: report.performance, comparison: report.comparison, pages: report.pages,
        preparations: report.preparations, full_manifest_preserved: report.full_manifest_preserved,
        preparation_state: report.preparation_state, failures: report.failures }));
    if (process.env.GITHUB_STEP_SUMMARY) {
        const { appendFile } = await import('node:fs/promises');
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `## Cover public index\n\n\`\`\`json\n${JSON.stringify({ head, snapshot: report.snapshot, budget: report.budget, index: report.index, preparations: report.preparations, full_manifest_preserved: report.full_manifest_preserved, preparation_state: report.preparation_state, summary: report.summary, performance: report.performance, comparison: report.comparison, failures: report.failures }, null, 2)}\n\`\`\`\n`);
    }
    if (report.failures.length) process.exitCode = 1;
}
