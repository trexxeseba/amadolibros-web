/**
 * functions/_shared/tarot-hub-modules.js
 *
 * TAROT-HUB-MERCH-1: selección determinista de qué módulos merchandising
 * mostrar en /libros/esoterismo-tarot y con qué productos, a partir del
 * artefacto de TAROT-MERCH-TAGS-1 (functions/_shared/tarot-merch-tags.js).
 *
 * Puro: no hace fetch, no renderiza HTML. functions/libros/[[path]].js sólo
 * llama a buildTarotHubModules() con los items ya resueltos (los mismos que
 * ya calcula la ruta hoy — ningún fetch adicional) y un lookup de tags.
 *
 * REGLA: un módulo con menos productos que su mínimo requerido no se
 * muestra con productos — o se oculta del todo, o (sólo "Para empezar")
 * queda como texto editorial sin grilla. Nunca se rellena con productos que
 * no cumplen el criterio del módulo.
 */

const PARA_EMPEZAR_MIN = 3;
const PARA_EMPEZAR_MAX = 6;
const MODULE_DISPLAY_CAP = 12; // tope de tarjetas por módulo — nunca cargar el universo completo de una

/**
 * Arma un lookup id->fila de TAROT_MERCH_TAGS que también resuelve por
 * cualquiera de los MLU duplicados absorbidos en la deduplicación del
 * artefacto (no sólo el representante) — necesario porque la grilla del
 * hub dedupea con su propio criterio (dedupeCategoryResults) y puede haber
 * elegido un representante distinto al de TAROT-MERCH-TAGS-1 para el mismo
 * título.
 */
export function buildTagLookup(tarotMerchTags) {
  const byAnyId = new Map();
  for (const row of tarotMerchTags) {
    for (const id of row.duplicate_mlu_ids || [row.id]) byAnyId.set(id, row);
  }
  return id => byAnyId.get(String(id || '').toUpperCase()) || null;
}

function cap(list) {
  return list.slice(0, MODULE_DISPLAY_CAP);
}

export function buildTarotHubModules({ items = [], tagLookup, demandLedgerLookup = () => null } = {}) {
  if (!Array.isArray(items)) throw new Error('items debe ser un array.');
  if (typeof tagLookup !== 'function') throw new Error('tagLookup debe ser una función.');

  const tagged = items
    .map(item => ({ item, tag: tagLookup(item.id) }))
    .filter(entry => entry.tag != null);

  const paraEmpezar = tagged.filter(e => e.tag.level === 'principiante');
  const oraculos = tagged.filter(e => e.tag.primary_type === 'oraculo');
  const clasicos = tagged.filter(e => e.tag.deck_family != null);
  const lenormandKipper = tagged.filter(e => e.tag.primary_type === 'lenormand' || e.tag.primary_type === 'kipper');
  const paraProfundizar = tagged.filter(e => e.tag.format === 'libro');
  const novedades = tagged.filter(e => e.tag.is_new_arrival === true);
  const volvioDisponible = tagged.filter(e => e.tag.is_restocked === true);
  const masBuscado = tagged
    .map(e => ({ ...e, demand: demandLedgerLookup(e.item.id) }))
    .filter(e => e.demand && Number(e.demand.opportunity_score) > 0)
    .sort((a, b) => b.demand.opportunity_score - a.demand.opportunity_score);

  const modules = [];

  // "Para empezar" es el único módulo que se mantiene visible incluso sin
  // productos (decisión aprobada): microexplicación + entrada futura al
  // Finder, sin inventar una grilla que no cumple el mínimo confiable.
  modules.push({
    id: 'para-empezar',
    title: 'Para empezar',
    kind: 'editorial-mini',
    entries: paraEmpezar.length >= PARA_EMPEZAR_MIN ? cap(paraEmpezar.slice(0, PARA_EMPEZAR_MAX)) : [],
    hasProducts: paraEmpezar.length >= PARA_EMPEZAR_MIN,
  });

  if (oraculos.length > 0) {
    modules.push({ id: 'oraculos', title: 'Oráculos', kind: 'grid', entries: cap(oraculos), totalCount: oraculos.length });
  }

  if (clasicos.length > 0) {
    modules.push({ id: 'clasicos', title: 'Clásicos', kind: 'grid-badged', entries: cap(clasicos), totalCount: clasicos.length });
  }

  if (lenormandKipper.length > 0) {
    modules.push({
      id: 'lenormand-kipper',
      title: 'Lenormand y Kipper',
      kind: 'grid-badged',
      entries: cap(lenormandKipper),
      totalCount: lenormandKipper.length,
    });
  }

  if (paraProfundizar.length > 0) {
    modules.push({
      id: 'para-profundizar',
      title: 'Para profundizar',
      kind: 'grid',
      entries: cap(paraProfundizar),
      totalCount: paraProfundizar.length,
    });
  }

  if (novedades.length > 0) {
    modules.push({ id: 'novedades', title: 'Novedades', kind: 'grid', entries: cap(novedades), totalCount: novedades.length });
  }

  // Sin señal real (Demand Ledger sin filas de score>0 para este universo
  // todavía, o lookup ausente porque DEMAND-LEDGER-1 no está mergeado) ->
  // el módulo directamente no se agrega. Nunca placeholder, nunca "próximamente".
  if (masBuscado.length > 0) {
    modules.push({ id: 'mas-buscado', title: 'Lo más buscado', kind: 'grid', entries: cap(masBuscado), totalCount: masBuscado.length });
  }

  // Mismo criterio: sin evidencia histórica de reposición, no se agrega.
  if (volvioDisponible.length > 0) {
    modules.push({
      id: 'volvio-disponible',
      title: 'Volvió a estar disponible',
      kind: 'grid',
      entries: cap(volvioDisponible),
      totalCount: volvioDisponible.length,
    });
  }

  return modules;
}
