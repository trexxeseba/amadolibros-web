import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { streamCoverManifest } from '../functions/_shared/cover-manifest-stream.js';
import { isEligibleForFeed, dedupeByGtinAndCondition, filterItemsWithReadyPrimaryCover, renderFeedItem } from '../functions/feed.xml.js';
import { coverManifestBudget, coverBudgetMessage } from '../functions/_shared/cover-manifest-budget.js';

const base = process.env.INCIDENT_URL;
const token = process.env.INCIDENT_TOKEN;
const head = process.env.INCIDENT_BUILD_SHA;
const output = 'artifacts/cover-resource';
const screenshotIds = ['MLU634431651', 'MLU709390092', 'MLU690771648', 'MLU679987262'];
const report = { head, observed_at: new Date().toISOString(), production_writes: 0, pages: [], images: [], failures: [] };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function request(path) {
    return fetch(new URL(path, base), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
}
async function imageCheck(path, immutable = false) {
    const start = Date.now();
    try {
        const response = await request(path);
        const bytes = Buffer.from(await response.arrayBuffer());
        const digest = hash(bytes);
        const expected = immutable ? /\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(path)?.[1]
            : response.headers.get('etag')?.replaceAll('"', '');
        const row = { path, status: response.status, sha256: digest, expected_sha256: expected,
            bytes: bytes.length, ms: Date.now() - start, manifest_reads: Number(response.headers.get('x-incident-manifest-reads')),
            retained: Number(response.headers.get('x-incident-retained')),
            deployed_head: response.headers.get('x-incident-build'), source: response.headers.get('x-cover-source') || response.headers.get('x-amado-cover-source') };
        row.ok = response.status === 200 && row.deployed_head === head && bytes.length > 0 &&
            response.headers.get('content-type')?.startsWith('image/') && expected === digest &&
            row.source === 'r2-production' && (!immutable || row.manifest_reads === 0);
        report.images.push(row);
        if (!row.ok) report.failures.push(`Image ${path}: HTTP ${response.status}, integrity/source/read failure`);
    } catch (error) { report.failures.push(`Image ${path}: ${error.message}`); }
}
try {
    await mkdir(output, { recursive: true });
    let ready = false;
    for (let n = 0; n < 12 && !ready; n++) {
        const r = await request('/ready').catch(() => null);
        ready = Boolean(r?.ok && (await r.json()).head === head);
        if (!ready) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!ready) throw new Error('Temporary worker not ready on the requested head');

    const manifestResponse = await request('/manifest');
    if (!manifestResponse.ok) throw new Error(`Manifest HTTP ${manifestResponse.status}`);
    const raw = Buffer.from(await manifestResponse.arrayBuffer());
    const original = JSON.parse(raw.toString('utf8'));
    const projected = await streamCoverManifest(new Response(raw));
    const catalogResponse = await fetch('https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json');
    if (!catalogResponse.ok) throw new Error(`Catalog HTTP ${catalogResponse.status}`);
    const catalog = await catalogResponse.json();
    const eligible = catalog.items.filter(isEligibleForFeed);
    const oldFeed = dedupeByGtinAndCondition(filterItemsWithReadyPrimaryCover(eligible, original, true));
    const newFeed = dedupeByGtinAndCondition(filterItemsWithReadyPrimaryCover(eligible, projected, true));
    const oldXml = oldFeed.map(item => renderFeedItem(item, original, null, true)).join('');
    const newXml = newFeed.map(item => renderFeedItem(item, projected, null, true)).join('');
    report.budget = coverManifestBudget({ manifestBytes: raw.length,
        entries: Object.keys(original.entries).length });
    console.log(coverBudgetMessage(report.budget));
    if (report.budget.level === 'critical') {
        report.failures.push(`Presupuesto de memoria del escritor de portadas: ${coverBudgetMessage(report.budget)}`);
    }

    report.snapshot = { catalog_updated_at: catalog.updated_at, manifest_etag: manifestResponse.headers.get('x-manifest-etag'),
        manifest_bytes: raw.length, manifest_sha256: hash(raw), entries: Object.keys(original.entries).length,
        old_feed_items: oldFeed.length, new_feed_items: newFeed.length, old_item_xml_sha256: hash(oldXml), new_item_xml_sha256: hash(newXml) };
    if (oldFeed.length === 0 || oldXml !== newXml) throw new Error('Merchant item XML differs after projection');
    await writeFile(`${output}/manifest-snapshot.json.gz`, gzipSync(raw));

    const paths = new Set();
    for (const page of ['/catalogo', '/catalogo?page=2', '/catalogo?disponibilidad=disponibles']) {
        const started = Date.now();
        const response = await request(page);
        const html = await response.text();
        const images = [...new Set([...html.matchAll(/\/preview-cover\/MLU\d+\/(?:[0-9]|1[0-5])\/[a-f0-9]{64}\.(?:jpg|png|webp)/g)].map(x => x[0]))];
        images.forEach(path => paths.add(path));
        const cards = (html.match(/<article class="rc-card/g) || []).length;
        const row = { path: page, status: response.status, cards, immutable_images: images.length,
            ms: Date.now() - started, retained: Number(response.headers.get('x-incident-retained')),
            manifest_reads: Number(response.headers.get('x-incident-manifest-reads')), deployed_head: response.headers.get('x-incident-build') };
        row.ok = response.ok && row.deployed_head === head && cards > 0 && images.length === cards;
        report.pages.push(row);
        if (!row.ok) report.failures.push(`Page ${page}: HTTP ${response.status}, cards=${cards}, immutable images=${images.length}`);
        await writeFile(`${output}/page-${report.pages.length}.html`, html);
    }
    for (const id of screenshotIds) {
        await imageCheck(`/book-cover/${id}/cover.jpg`);
        const current = original.entries[`${id}:0`]?.current;
        if (!current?.sha256) { report.failures.push(`Screenshot product missing ${id}`); continue; }
        paths.add(`/preview-cover/${id}/0/${current.sha256}.${current.mime === 'image/jpeg' ? 'jpg' : current.mime.slice(6)}`);
    }
    const remaining = [...paths];
    await Promise.all(Array.from({ length: 3 }, async () => {
        while (remaining.length) await imageCheck(remaining.shift(), true);
    }));
    if (report.images.length < screenshotIds.length * 2) report.failures.push('Insufficient image checks');
} catch (error) {
    report.failures.push(error.stack || error.message);
} finally {
    report.completed_at = new Date().toISOString();
    report.summary = { pages: report.pages.length, pages_ok: report.pages.filter(x => x.ok).length,
        images: report.images.length, images_ok: report.images.filter(x => x.ok).length, failures: report.failures.length };
    await writeFile(`${output}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ snapshot: report.snapshot, budget: report.budget, summary: report.summary, pages: report.pages, failures: report.failures }));
    if (report.failures.length) process.exitCode = 1;
}
