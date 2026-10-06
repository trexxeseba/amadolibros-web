/**
 * worker-sync/catalog-sync-log.js
 *
 * INFORME-ANALITICO: qué cambió en cada sync del catálogo activo. Hasta acá
 * catalog.json se sobrescribía sin dejar rastro y no había forma de saber
 * cuántos libros entraron, salieron o cambiaron de precio en la semana.
 *
 * Se compara contra el catalog.json publicado antes (el mismo que ya lee
 * IndexNow) y se guarda una fila por corrida en D1 `catalog_sync_log`: los
 * conteos y unos pocos ejemplos. Sin baseline la fila queda marcada como tal
 * y con los cambios en cero: nunca se finge que todo el catálogo es nuevo.
 *
 * Nada de esto puede tumbar un sync ya publicado: quien la llama atrapa
 * cualquier error.
 */

const SAMPLE_LIMIT = 10;

function itemsById(catalog) {
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  return new Map(items.filter(item => item?.id).map(item => [String(item.id), item]));
}

function price(item) {
  const value = Number(item?.price);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function available(item) {
  return item?.status === 'active' && Number(item?.available_quantity) > 0;
}

function sample(item, extra = {}) {
  return { id: String(item.id), title: String(item.title || '').slice(0, 80), ...extra };
}

/**
 * Diferencias entre el catálogo anterior y el nuevo. Pura.
 * @returns {{ total_items, available_items, previous_total, added, removed,
 *   price_up, price_down, out_of_stock, back_in_stock, baseline, samples }}
 */
export function buildCatalogDiff(previousCatalog, nextCatalog) {
  const next = itemsById(nextCatalog);
  const base = {
    total_items: next.size,
    available_items: [...next.values()].filter(available).length,
    previous_total: null,
    added: 0, removed: 0, price_up: 0, price_down: 0, out_of_stock: 0, back_in_stock: 0,
    baseline: false,
    samples: { added: [], removed: [], price_changes: [] },
  };
  if (!Array.isArray(previousCatalog?.items)) return base;

  const previous = itemsById(previousCatalog);
  const diff = { ...base, previous_total: previous.size, baseline: true };
  const priceChanges = [];

  for (const [id, item] of next) {
    const before = previous.get(id);
    if (!before) {
      diff.added += 1;
      if (diff.samples.added.length < SAMPLE_LIMIT) diff.samples.added.push(sample(item, { price: price(item) }));
      continue;
    }
    const oldPrice = price(before);
    const newPrice = price(item);
    if (oldPrice !== null && newPrice !== null && oldPrice !== newPrice) {
      if (newPrice > oldPrice) diff.price_up += 1;
      else diff.price_down += 1;
      priceChanges.push(sample(item, { from: oldPrice, to: newPrice }));
    }
    if (available(before) && !available(item)) diff.out_of_stock += 1;
    if (!available(before) && available(item)) diff.back_in_stock += 1;
  }
  for (const [id, item] of previous) {
    if (next.has(id)) continue;
    diff.removed += 1;
    if (diff.samples.removed.length < SAMPLE_LIMIT) diff.samples.removed.push(sample(item));
  }

  // Los cambios de precio más grandes primero: son los que vale la pena mirar.
  diff.samples.price_changes = priceChanges
    .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from))
    .slice(0, SAMPLE_LIMIT);
  return diff;
}

export async function recordCatalogSyncLog(env, diff, syncedAt) {
  const db = env?.ORDERS_DB;
  if (!db || typeof db.prepare !== 'function') return { status: 'skipped', reason: 'no-db' };
  await db.prepare(
    'INSERT OR IGNORE INTO catalog_sync_log (id, synced_at, total_items, available_items, previous_total, ' +
    'added, removed, price_up, price_down, out_of_stock, back_in_stock, baseline, samples_json) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).bind(
    `sync:${syncedAt}`,
    syncedAt,
    diff.total_items,
    diff.available_items,
    diff.previous_total,
    diff.added,
    diff.removed,
    diff.price_up,
    diff.price_down,
    diff.out_of_stock,
    diff.back_in_stock,
    diff.baseline ? 1 : 0,
    JSON.stringify(diff.samples),
  ).run();
  return { status: 'recorded' };
}
