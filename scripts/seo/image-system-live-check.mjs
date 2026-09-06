import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inspectCoverBytes } from '../../worker-sync/cover-mirror.js';
const base = process.env.QW2_PREVIEW_URL;
if (!base || !/^https:\/\/pr-\d+\.amadolibros-web\.pages\.dev$/.test(base)) throw new Error('Expected isolated PR Preview URL');
const out = 'artifacts/image-system';
await mkdir(out, {recursive: true});
const seed = JSON.parse(await readFile(out+'/r2-seed.json', 'utf8'));
const rows = [];
// All copies from the automatic batch are verified, including small images.
// Small originals must remain honestly queued; they do not count as fixed.
for (const entry of seed.entries) {
  const row = {key: entry.key, status: entry.status, google_ready: entry.google_ready};
  rows.push(row);
  if (entry.status === 'failed') {
    row.ok = Boolean(entry.error);
    row.queued_failure = true;
    continue;
  }
  try {
    const path = `/book-cover/${entry.id}/${entry.position === 0 ? 'cover.jpg' : `cover-${entry.position+1}.jpg`}`;
    row.path = path;
    const response = await fetch(base+path, {signal: AbortSignal.timeout(30000)});
    if (!response.ok) throw new Error('Preview HTTP '+response.status);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const measured = inspectCoverBytes(bytes, response.headers.get('content-type'));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    row.preview = {...measured, sha256, source: response.headers.get('x-cover-source')};
    if (row.preview.source !== 'r2-preview' || sha256 !== entry.current.sha256) throw new Error('Preview must serve the exact R2 master');
    if (measured.width !== entry.current.width || measured.height !== entry.current.height) throw new Error('Manifest dimensions do not match bytes');
    if (entry.current.transform && entry.current.sha256 !== entry.previous?.sha256) throw new Error('New masters must use native originals');
    row.source_improved = entry.probes.some(probe => probe.source_url === entry.current.source_url && !probe.rejected && probe.width &&
      measured.width >= probe.width && measured.height >= probe.height &&
      measured.width * measured.height > probe.width * probe.height);
    row.master_upgraded = Boolean(entry.previous && measured.width >= entry.previous.width && measured.height >= entry.previous.height &&
      measured.width * measured.height > entry.previous.width * entry.previous.height);
    row.ok = true;
  } catch (error) { row.ok = false; row.error = error.message; }
}
const summary = {catalog_products: seed.catalog_products, catalog_images: seed.catalog_images,
  automatic_batch: rows.length, r2_verified: rows.filter(row => row.ok && row.preview).length,
  larger_than_catalog_source: rows.filter(row => row.source_improved).length,
  existing_masters_upgraded: rows.filter(row => row.master_upgraded).length,
  google_ready: rows.filter(row => row.ok && row.google_ready).length,
  queued_failures: rows.filter(row => row.queued_failure).length,
  validation_failures: rows.filter(row => !row.ok).length, preflight: seed.preflight, quality: seed.quality};
await writeFile(out+'/live-report.json', JSON.stringify({generated_at: new Date().toISOString(), preview: base,
  catalog_updated_at: seed.catalog_updated_at, summary, rows}, null, 2));
console.log(JSON.stringify(summary));
if (summary.validation_failures || !summary.r2_verified) process.exitCode = 1;
