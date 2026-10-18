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

// Sin inventario general: se parte del manifest ya existente y sólo se sondea (HEAD de
// tres claves v1, vía la fachada de solo lectura del Worker de Preview) a los masters
// elegidos. Si alguno ya tiene v1 se descarta y se vuelve a elegir. Cada hash se sondea
// una sola vez; el total queda acotado por rondas × 11.
export async function selectWithProbe({ manifest, probe, maxRounds = 6 }) {
  const known = new Set(), probed = new Set();
  for (let round = 1; round <= maxRounds; round++) {
    const selection = selectPilotMasters({ manifest, v1Inventory: known });
    const fresh = [...selection.pilot.items, ...selection.exhaustion.items].map(item => item.file.slice(0, 64)).filter(hash => !probed.has(hash));
    let changed = false;
    for (const hash of fresh) {
      probed.add(hash);
      const present = await probe(hash);
      for (const id of present) { known.add(`${hash}/${id}`); changed = true; }
    }
    if (!changed) return { ...selection, probes: probed.size, rounds: round };
  }
  throw new Error('pilot-selection-did-not-converge');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifestPath, outputPath, inventoryPath] = process.argv.slice(2);
  if (!manifestPath || !outputPath) throw new Error('usage: select-pilot-masters manifest.json pilot-selection.json [v1-inventory-keys.json]  (PILOT_URL + PILOT_TOKEN enable the read-only probe)');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  let selection;
  if (process.env.PILOT_URL) {
    const base = new URL(process.env.PILOT_URL);
    if (base.protocol !== 'https:' || base.username || !process.env.PILOT_TOKEN) throw new Error('invalid-probe-config');
    const probe = async hash => {
      const response = await fetch(new URL(`/probe-v1/${hash}`, base), { headers: { authorization: `Bearer ${process.env.PILOT_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`probe-http-${response.status}`);
      const body = await response.json();
      if (body.hash !== hash || !Array.isArray(body.present) || !body.present.every(id => /^v1-\d+-q\d+$/.test(id))) throw new Error('probe-invalid-response');
      return body.present;
    };
    selection = await selectWithProbe({ manifest, probe });
  } else {
    if (!inventoryPath) throw new Error('v1-inventory-or-probe-required');
    const keys = JSON.parse(await readFile(inventoryPath, 'utf8'));
    const v1Inventory = new Set(keys.map(key => /^covers\/variants\/v1\/([a-f0-9]{64})\/(v1-\d+-q\d+)\.webp$/.exec(key))
      .filter(Boolean).map(m => `${m[1]}/${m[2]}`));
    selection = selectPilotMasters({ manifest, v1Inventory });
  }
  await writeFile(outputPath, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ candidates: selection.candidates, probes: selection.probes ?? null, pilot_items: selection.pilot.items.length,
    pilot_hashes: selection.pilot.items.map(i => i.file), pilot_digest: selection.pilot.items_sha256,
    exhaustion_hashes: selection.exhaustion.items.map(i => i.file), exhaustion_digest: selection.exhaustion.items_sha256,
    strata: selection.strata, production_writes: 0 }));
}
