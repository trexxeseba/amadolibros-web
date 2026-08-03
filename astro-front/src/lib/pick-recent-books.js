// Lógica de selección de "Incorporaciones recientes" — usada por
// BestsellerSection.astro. Extraída a un módulo aparte para poder testear
// sin necesidad de un harness de Astro (mismo patrón que turnstile-hosts.js).
//
// HOME-RECENT-NEW-ONLY: la home debe mostrar solo libros nuevos. El campo
// `condition` viene directo de MercadoLibre (worker-sync/meli-catalog.js) y
// ya es la fuente de verdad usada en la ficha de producto y en el
// schema.org itemCondition — no es una inferencia nueva. Un valor ausente,
// null, undefined o distinto de 'new' se EXCLUYE siempre: nunca se asume
// "nuevo" por defecto.

export const ANTIQUE_SIGNALS = [
  'cruz', 'crucifijo', 'bronce', 'chapa esmaltada', 'cartel chapa',
  'dije', 'plata 925', 'jaspe', 'colgante vintage', 'sacapuntas vintage',
  'candelabro', 'figura bronce', 'figuras bronce',
  'decorativo', 'decorativa',
  'pared cristo', 'cristo inri', 'inri antigua',
  'jeringa',
  'veterinaria vidrio',
  'volante cine',
  'antiguo matrimonio',
  'antigua veterinaria',
  'pieza antigua',
  'objeto antiguo',
];

export function isAntiqueObject(b) {
  if (b.author && b.author.trim()) return false;
  const t = (b.title || '').toLowerCase();
  return ANTIQUE_SIGNALS.some(s => t.includes(s));
}

export function normalizeIdentity(v) {
  return String(v || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Filtra activos-con-stock-nuevos (sin antigüedades), ordena por start_time
// desc, deduplica por autor+precio y corta a `max`. El filtro de condición
// corre en el primer paso, antes de ordenar/cortar — nunca después.
export function pickRecentBooks(items, max = 8) {
  const filtered = (items || [])
    .filter(b => b.status === 'active' && Number(b.available_quantity) > 0 && b.condition === 'new' && !isAntiqueObject(b))
    .sort((a, b) => {
      const ta = a.start_time ? new Date(a.start_time).getTime() : 0;
      const tb = b.start_time ? new Date(b.start_time).getTime() : 0;
      return tb - ta;
    });

  const seen = new Set();
  return filtered.filter(b => {
    const authorKey = normalizeIdentity(b.author);
    const identityKey = authorKey || normalizeIdentity(b.title).slice(0, 60);
    const key = `${identityKey}|${Number(b.price || 0)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max);
}
