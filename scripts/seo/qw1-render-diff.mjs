import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// QW1 — compara dos informes de render producidos con el MISMO snapshot de
// catálogo: uno con el renderizador de `main` y otro con el de la rama del
// PR #313. Responde la pregunta que faltaba: qué casos reales cambia el fix.

function asText(value) {
  return String(value ?? '').trim();
}

function offerKey(offer) {
  if (!offer) return 'sin-offer';
  return [offer.price, offer.priceCurrency, offer.availability, offer.url].join('|');
}

export function classifyChange(before, after) {
  const hadOffer = Boolean(before?.offer);
  const hasOffer = Boolean(after?.offer);
  if (!hadOffer && hasOffer) return 'offer_agregado';
  if (hadOffer && !hasOffer) return 'offer_removido';
  if (hadOffer && hasOffer && offerKey(before.offer) !== offerKey(after.offer)) return 'offer_modificado';
  return 'sin_cambio';
}

// Coherencia comercial: publicar un Offer con precio mientras la ficha no
// muestra ningún precio visible es incoherente para una persona; publicar el
// botón de compra sin stock sería peor. Se mide, no se asume.
export function coherence(row) {
  const hasOffer = Boolean(row?.offer);
  const availability = row?.offer?.availability || null;
  return {
    offerSinPrecioVisible: hasOffer && !row.visiblePriceBox,
    precioVisibleSinOffer: !hasOffer && Boolean(row.visiblePriceBox),
    botonCompraSinStock: Boolean(row.cartButton) && Number(row.available_quantity) <= 0,
    offerOutOfStockConBoton: availability === 'OutOfStock' && Boolean(row.cartButton),
  };
}

export async function main() {
  const beforePath = asText(process.env.QW1_DIFF_BEFORE) || 'artifacts/qw1/render-main.json';
  const afterPath = asText(process.env.QW1_DIFF_AFTER) || 'artifacts/qw1/render-pr313.json';
  const outputPath = asText(process.env.QW1_DIFF_OUTPUT) || 'artifacts/qw1/render-diff.json';

  const before = JSON.parse(await readFile(beforePath, 'utf8'));
  const after = JSON.parse(await readFile(afterPath, 'utf8'));
  const beforeById = new Map(before.results.map(row => [row.id, row]));
  const afterById = new Map(after.results.map(row => [row.id, row]));

  const changes = [];
  const counts = { offer_agregado: 0, offer_removido: 0, offer_modificado: 0, sin_cambio: 0 };
  const coherenceCounts = {
    before: { offerSinPrecioVisible: 0, precioVisibleSinOffer: 0, botonCompraSinStock: 0, offerOutOfStockConBoton: 0 },
    after: { offerSinPrecioVisible: 0, precioVisibleSinOffer: 0, botonCompraSinStock: 0, offerOutOfStockConBoton: 0 },
  };

  for (const [id, beforeRow] of beforeById) {
    const afterRow = afterById.get(id);
    if (!afterRow) continue;
    const change = classifyChange(beforeRow, afterRow);
    counts[change] += 1;
    for (const [key, value] of Object.entries(coherence(beforeRow))) {
      if (value) coherenceCounts.before[key] += 1;
    }
    for (const [key, value] of Object.entries(coherence(afterRow))) {
      if (value) coherenceCounts.after[key] += 1;
    }
    if (change !== 'sin_cambio') {
      changes.push({
        id,
        change,
        status: afterRow.status,
        price: afterRow.price,
        available_quantity: afterRow.available_quantity,
        before: beforeRow.offer,
        after: afterRow.offer,
        visiblePriceBox: afterRow.visiblePriceBox,
        cartButton: afterRow.cartButton,
      });
    }
  }

  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    before: { label: before.label, sha: before.gitSha, items: before.results.length },
    after: { label: after.label, sha: after.gitSha, items: after.results.length },
    snapshot: after.snapshot || before.snapshot || null,
    comparedItems: [...beforeById.keys()].filter(id => afterById.has(id)).length,
    counts,
    coherence: coherenceCounts,
    changes,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`);

  console.log('=== QW1 DIFF DE RENDERIZADORES (main vs PR #313, mismo snapshot) ===');
  console.log(JSON.stringify({ ...summary, changes: undefined }, null, 2));
  console.log('=== QW1 cambios reales (hasta 20) ===');
  console.log(JSON.stringify(changes.slice(0, 20), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
