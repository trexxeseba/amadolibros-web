// Offline selection only: reads frozen inputs; never requests or writes R2.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { CF_CARD_VARIANTS, CARD_WIDTHS, VARIANT_VERSION } from '../../shared/image-variants.js';

const RECIPES = CF_CARD_VARIANTS.map(r => r.id);
const MAX_BYTES = 8 * 1024 * 1024;

// Diez masters que cubren los casos que el piloto debe demostrar, más uno
// adicional (sólo para probar cupo agotado). Candidatos: masters de portada
// (posición 0) sin NINGUNA receta v1 existente, de modo que el piloto no genera
// nada que ya se pueda reutilizar. Determinista: dentro de cada estrato gana el
// hash menor.
const STRATA = [
  ['jpg-estandar-1', m => m.ext === 'jpg' && m.width >= 600 && m.width <= 1400 && m.height > m.width],
  ['jpg-estandar-2', m => m.ext === 'jpg' && m.width >= 600 && m.width <= 1400 && m.height > m.width],
  ['png', m => m.ext === 'png'],
  ['webp', m => m.ext === 'webp'],
  ['apaisado', m => m.width > m.height && m.width >= 500],
  ['muy-alto', m => m.height / m.width >= 1.7],
  ['grande', m => m.width >= 1500],
  ['angosto-241-359', m => m.width > 240 && m.width < 360],
  ['diminuto-hasta-240', m => m.width <= 240],
  ['bajo-480-361-479', m => m.width > 360 && m.width < 480],
];

function candidates(manifest, v1Inventory) {
  if (!manifest?.entries || typeof manifest.entries !== 'object') throw new Error('pilot-manifest-invalid');
  const byHash = new Map();
  for (const [key, entry] of Object.entries(manifest.entries)) {
    if (!key.endsWith(':0')) continue;
    const current = entry?.current;
    const match = /^covers\/v1\/objects\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(current?.object_key || '');
    if (!match || current.sha256 !== match[1] || !Number.isSafeInteger(current.bytes) || current.bytes < 1 || current.bytes > MAX_BYTES ||
        !Number.isSafeInteger(current.width) || !Number.isSafeInteger(current.height) ||
        current.width < 100 || current.height < 100 || current.width > 12_000 || current.height > 12_000) continue;
    if (CARD_WIDTHS.some(w => v1Inventory.has(`${match[1]}/${VARIANT_VERSION}-${w}-q85`))) continue;
    byHash.set(match[1], { hash: match[1], ext: match[2], size: current.bytes, width: current.width, height: current.height });
  }
  return [...byHash.values()].sort((a, b) => a.hash.localeCompare(b.hash));
}

const planOf = (masters, meta) => {
  const items = masters.map(m => ({ file: `${m.hash}.${m.ext}`, size: m.size, width: m.width, height: m.height, recipes: RECIPES }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { schema: 'card-generation-plan-v2', recipes: RECIPES, ...meta, items,
    items_sha256: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
};

export function selectPilotMasters({ manifest, v1Inventory }) {
  const pool = candidates(manifest, v1Inventory);
  const chosen = [], strata = [], used = new Set();
  const take = (label, predicate) => {
    const found = pool.find(m => !used.has(m.hash) && predicate(m));
    if (found) { used.add(found.hash); chosen.push(found); }
    strata.push({ stratum: label, hash: found?.hash || null, filled: Boolean(found) });
    return Boolean(found);
  };
  for (const [label, predicate] of STRATA) take(label, predicate);
  // Estratos vacíos: se completan con el menor hash restante y se informa.
  for (const row of strata.filter(s => !s.filled)) {
    const filler = pool.find(m => !used.has(m.hash));
    if (filler) { used.add(filler.hash); chosen.push(filler); row.hash = filler.hash; row.filler = true; }
  }
  const extra = pool.find(m => !used.has(m.hash));
  if (chosen.length < STRATA.length || !extra) throw new Error('pilot-candidates-insufficient');
  const meta = { manifest_updated_at: manifest.updated_at || null, selection: 'pilot-v1' };
  return { pilot: planOf(chosen, meta), exhaustion: planOf([extra], { ...meta, selection: 'exhaustion-v1' }), strata,
    candidates: pool.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifestPath, inventoryPath, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error('usage: select-pilot-masters manifest.json v1-inventory-keys.json pilot-selection.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const keys = JSON.parse(await readFile(inventoryPath, 'utf8'));
  const v1Inventory = new Set(keys.map(key => /^covers\/variants\/v1\/([a-f0-9]{64})\/(v1-\d+-q\d+)\.webp$/.exec(key))
    .filter(Boolean).map(m => `${m[1]}/${m[2]}`));
  const selection = selectPilotMasters({ manifest, v1Inventory });
  await writeFile(outputPath, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ candidates: selection.candidates, pilot_items: selection.pilot.items.length,
    pilot_digest: selection.pilot.items_sha256, exhaustion_digest: selection.exhaustion.items_sha256,
    strata: selection.strata, production_requests: 0, production_writes: 0 }));
}
