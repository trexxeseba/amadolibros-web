import { createHash } from 'node:crypto';
import { normalizeSourceUrl } from '../../functions/_shared/preview-cover.js';
import {
  PRODUCTION_IMAGE_BUCKET, READINESS_V2_SCHEMA, MAX_CARD_READINESS_V2_ENTRIES, MAX_CARD_READINESS_V2_BYTES,
} from '../../functions/_shared/card-variant-delivery.js';
import {
  CARD_WIDTHS, CF_ENCODER, CF_VARIANT_VERSION, VARIANT_VERSION, imageVariant, variantVersion,
} from '../../shared/image-variants.js';

const HASH = /^[a-f0-9]{64}$/;
const EXTENSIONS = ['jpg', 'png', 'webp'];

// Evidencia de un objeto ya almacenado y releído (HEAD/GET de R2), nunca una
// afirmación de que "debería existir". Falla en voz alta si algo no cuadra.
function validateEvidence(hash, recipe, master, evidence) {
  const encoderOk = variantVersion(recipe.id) === CF_VARIANT_VERSION
    ? evidence.encoder === CF_ENCODER
    : evidence.encoder === undefined || evidence.encoder === 'sharp';
  const width = Math.min(master.width, recipe.width);
  const height = Math.max(1, Math.round(master.height * width / master.width));
  if (evidence.recipe !== recipe.id || evidence.master_sha256 !== hash || !encoderOk ||
      evidence.format !== 'webp' || !(evidence.bytes > 0) || !HASH.test(evidence.sha256 || '') ||
      evidence.width !== width || !Number.isInteger(evidence.height) || Math.abs(evidence.height - height) > 1)
    throw new Error('readiness-evidence-invalid');
}

// Función pura: sin red, sin encoder, sin escrituras. Para cada master y ancho
// elige una receta existente y verificada (preferencia configurable; por
// defecto reutiliza v1 antes que v2) y no incluye tarjetas con cobertura
// incompleta: esas siguen sirviendo el original.
export function buildMixedCardReadiness({ cards, masters, evidence, prefer = [VARIANT_VERSION, CF_VARIANT_VERSION] }) {
  if (!cards || !masters || !evidence || !prefer.every(v => [VARIANT_VERSION, CF_VARIANT_VERSION].includes(v)))
    throw new Error('readiness-input-invalid');
  const selection = {};
  const publishedMasters = {};
  const publishedCards = {};
  const stats = { v1: 0, v2: 0, excludedCards: 0 };
  for (const hash of Object.keys(masters).sort()) {
    const master = masters[hash];
    if (!HASH.test(hash) || !EXTENSIONS.includes(master?.extension) ||
        !Number.isInteger(master.width) || !Number.isInteger(master.height) || master.width < 1 || master.height < 1)
      throw new Error('readiness-master-invalid');
    let code = '';
    for (const width of CARD_WIDTHS) {
      let chosen = '0';
      for (const version of prefer) {
        const recipe = imageVariant(`${version}-${width}-q85`);
        const found = evidence[`${hash}/${recipe.id}`];
        if (!found) continue;
        validateEvidence(hash, recipe, master, found);
        chosen = version.slice(1);
        break;
      }
      code += chosen;
    }
    selection[hash] = code;
  }
  for (const id of Object.keys(cards).sort()) {
    const row = cards[id];
    const source = normalizeSourceUrl(row?.source_url);
    if (!/^MLU\d+$/.test(id) || !HASH.test(row?.sha256 || '') || !masters[row.sha256] ||
        masters[row.sha256].extension !== row.extension || !source) throw new Error('readiness-card-invalid');
    if (selection[row.sha256].includes('0')) { stats.excludedCards++; continue; }
    publishedCards[id] = { sha256: row.sha256, extension: row.extension, source_url: source };
    publishedMasters[row.sha256] = selection[row.sha256];
  }
  for (const code of Object.values(publishedMasters)) for (const c of code) stats['v' + c]++;
  if (Object.keys(publishedCards).length > MAX_CARD_READINESS_V2_ENTRIES) throw new Error('readiness-entry-budget');
  const text = JSON.stringify({
    schema: READINESS_V2_SCHEMA, bucket: PRODUCTION_IMAGE_BUCKET, widths: CARD_WIDTHS,
    cards: publishedCards, masters: publishedMasters,
  });
  const bytes = Buffer.byteLength(text);
  if (bytes > MAX_CARD_READINESS_V2_BYTES) throw new Error('readiness-byte-budget');
  const digest = createHash('sha256').update(text).digest('hex');
  return { text, digest, key: `covers/card-readiness/v1/${digest}.json`, bytes,
    cards: Object.keys(publishedCards).length, masters: Object.keys(publishedMasters).length, ...stats };
}
