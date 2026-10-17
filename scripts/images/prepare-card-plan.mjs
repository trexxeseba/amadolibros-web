// Offline selection only: reads frozen inputs; never requests or writes R2.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CARD_RECIPES, validateCardPlan } from './build-permanent-variants.mjs';

function sourceUrl(value) {
  const url = new URL(value);
  url.protocol = 'https:';
  url.pathname = url.pathname.replace(/-I\.(jpg|jpeg|png|webp)$/, '-O.$1');
  url.hash = '';
  return url.href;
}

export function prepareCardPlan(manifest, catalog, externalIds) {
  if (manifest.updated_at !== '2026-10-17T03:10:32.644Z' ||
      catalog.updated_at !== '2026-10-17T03:10:21.984Z' ||
      new Set(externalIds).size !== 8225) throw new Error('inventory-input-snapshot-mismatch');
  const ids = new Set(externalIds), targets = new Map();
  let active = 0;
  for (const item of catalog.items) {
    if (!ids.has(item.id) || item.status !== 'active' || !(item.available_quantity > 0)) continue;
    active++;
    const current = manifest.entries[item.id + ':0']?.current;
    const match = /^covers\/v1\/objects\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(current?.object_key || '');
    const picture = (item.pictures || [item.thumbnail])[0];
    if (!match || match[1] !== current.sha256 || sourceUrl(picture) !== sourceUrl(current.source_url))
      throw new Error('active-master-mismatch');
    const master = { file: current.object_key.slice('covers/v1/objects/'.length), size: current.bytes };
    const previous = targets.get(match[1]);
    if (previous && JSON.stringify(previous) !== JSON.stringify(master)) throw new Error('conflicting-master');
    targets.set(match[1], master);
  }
  if (active !== 2790 || targets.size !== 2788) throw new Error('inventory-scope-mismatch');
  const masters = [...targets.values()].sort((a, b) => a.file.localeCompare(b.file));
  const plan = { schema: 'active-card-variants-v1', bucket: 'amadolibros-images-production',
    baseline: '29c5dce82ce807fdcd58d3c49c21fc64dc2b5cea',
    manifest_updated_at: manifest.updated_at, catalog_updated_at: catalog.updated_at,
    recipes: CARD_RECIPES, masters,
    masters_sha256: createHash('sha256').update(JSON.stringify(masters)).digest('hex') };
  validateCardPlan(plan);
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifestPath, catalogPath, idsPath, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error('usage: prepare-card-plan manifest.json catalog.json external-ids.json private-plan.json');
  const inputs = await Promise.all([manifestPath, catalogPath, idsPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const plan = prepareCardPlan(...inputs);
  await writeFile(outputPath, JSON.stringify(plan), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ masters: plan.masters.length, variants: plan.masters.length * 3, plan_sha256: plan.masters_sha256, production_writes: 0 }));
}
