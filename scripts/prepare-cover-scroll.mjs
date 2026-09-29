import { mkdir, writeFile } from 'node:fs/promises';

const origin = process.env.INCIDENT_URL;
const headers = { authorization: `Bearer ${process.env.INCIDENT_TOKEN}` };
const request = (path, options = {}) => fetch(new URL(path, origin), {
    ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(120_000),
});
await mkdir('artifacts/cover-scroll', { recursive: true });
let ready = false;
for (let n = 0; n < 12 && !ready; n++) {
    const response = await request('/ready').catch(() => null);
    ready = Boolean(response?.ok && (await response.json()).head === process.env.INCIDENT_BUILD_SHA);
    if (!ready) await new Promise(resolve => setTimeout(resolve, 2000));
}
if (!ready) throw new Error('Worker not ready on requested head');
const snapshot = await request('/manifest');
if (!snapshot.ok) throw new Error(`Freeze snapshot: HTTP ${snapshot.status}`);
const etag = snapshot.headers.get('x-manifest-etag');
// Complete the snapshot response before bootstrapping; do not overlap a
// cancelled R2 response with the next memory-heavy preparation request.
let snapshotBytes = 0;
for await (const chunk of snapshot.body) snapshotBytes += chunk.byteLength;
console.log(JSON.stringify({ stage: 'snapshot-complete', bytes: snapshotBytes }));
const prepared = await request('/prepare', { method: 'POST', headers: { 'if-match': etag } });
if (!prepared.ok) throw new Error(`Prepare full index: HTTP ${prepared.status}: ${await prepared.text()}`);
const index = await prepared.json();
const info = { head: process.env.INCIDENT_BUILD_SHA, origin, url: `${origin}/libros/psicologia`,
    expires_at: new Date(Number(process.env.SCROLL_EXPIRES_AT)).toISOString(), index,
    scope: 'Real renderer and lazy image attributes; responsive variants use native Cloudflare Images binding in isolated Worker, not the production CDN URL cache.',
    production_writes: 0 };
await writeFile('artifacts/cover-scroll/browser-info.json', `${JSON.stringify(info, null, 2)}\n`);
console.log(JSON.stringify(info));
