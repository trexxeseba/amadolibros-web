import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { normalizeSourceUrl } from '../../functions/_shared/preview-cover.js';
import { CARD_RECIPES, PRODUCTION_IMAGE_BUCKET } from '../../functions/_shared/card-variant-delivery.js';
import { validateCardPlan } from './build-permanent-variants.mjs';

// Local artifact only. Requires per-object evidence from the authenticated,
// decrypted read-only checkpoint; aggregate totals are insufficient.
export function prepareCardReadiness({ manifest, catalog, plan, verified }) {
  validateCardPlan(plan);
  if (catalog.items.length !== 2790 || manifest.updated_at !== plan.manifest_updated_at ||
      catalog.updated_at !== plan.catalog_updated_at || Object.keys(verified || {}).length !== 8364)
    throw new Error('readiness-evidence-scope-mismatch');
  const masters = new Set(plan.masters.map(m => m.file));
  const cards = {}, pairs = new Set();
  for (const item of catalog.items) {
    const current = manifest.entries[item.id + ':0']?.current;
    const match = /^covers\/v1\/objects\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(current?.object_key || '');
    const source = normalizeSourceUrl(item.pictures?.[0]);
    if (!match || current.sha256 !== match[1] || !masters.has(match[1]+'.'+match[2]) ||
        !source || source !== normalizeSourceUrl(current.source_url) || cards[item.id] ||
        item.status !== 'active' || !(item.available_quantity > 0)) throw new Error('readiness-card-mismatch');
    for (const recipe of CARD_RECIPES) {
      const key = match[1]+'/'+recipe, evidence = verified[key];
      if (!(evidence?.bytes > 0) || !/^[a-f0-9]{64}$/.test(evidence.sha256 || ''))
        throw new Error('readiness-variant-not-verified');
      pairs.add(key);
    }
    cards[item.id] = { sha256:match[1], extension:match[2], source_url:source };
  }
  if (pairs.size !== 8364) throw new Error('readiness-coverage-mismatch');
  const text = JSON.stringify({schema:'verified-card-readiness-v1', bucket:PRODUCTION_IMAGE_BUCKET,
    recipes:CARD_RECIPES, masters_sha256:plan.masters_sha256, cards});
  const digest = createHash('sha256').update(text).digest('hex');
  return { text, digest, key:`covers/card-readiness/v1/${digest}.json` };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifest,catalog,plan,verified] = await Promise.all(process.argv.slice(2,6).map(async p => JSON.parse(await readFile(p,'utf8'))));
  const result = prepareCardReadiness({manifest,catalog,plan,verified});
  if (!process.argv[6]) throw new Error('local-output-required');
  await writeFile(process.argv[6], result.text, {mode:0o600,flag:'wx'});
  console.log(JSON.stringify({cards:2790,variants:8364,bytes:Buffer.byteLength(result.text),production_writes:0}));
}
