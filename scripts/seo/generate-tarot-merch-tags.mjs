#!/usr/bin/env node

/**
 * scripts/seo/generate-tarot-merch-tags.mjs
 *
 * TAROT-MERCH-TAGS-1: clasifica de forma determinista y conservadora el
 * inventario real de Amado relacionado con tarot, oráculos, Lenormand y
 * Kipper, y escribe un artefacto generado/versionado — mismo patrón que
 * generate-paused-cohort.mjs / generate-demand-ledger.mjs.
 *
 * NO renderiza ni modifica ninguna página. Este lote sólo produce datos
 * para que TAROT-HUB-MERCH-1 y TAROT-FINDER-1 los consuman.
 *
 * REGLA SEMÁNTICA FUNDAMENTAL (no negociable en este archivo):
 *   Lenormand no es tarot. Kipper no es tarot. Oráculo no es tarot.
 *   Cada uno tiene su propio primary_type; nunca se colapsan entre sí.
 *
 * REGLA DE CLASIFICACIÓN: si un atributo no está demostrado por el título o
 * la descripción real del catálogo, el resultado es 'desconocido' (o null
 * en los ejes opcionales sin señal) — nunca una inferencia por estética,
 * intuición o "probablemente". Esto es intencional incluso cuando produce
 * muchos 'desconocido': un catálogo de MercadoLibre migrado tiene
 * `bibliographic` casi siempre null y títulos truncados/ruidosos (ver
 * docs/seo/tarot-merch-tags-audit-*.md) — clasificar mal es peor que no
 * clasificar.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Universo candidato — red amplia deliberada. Cualquier duda de si algo
// pertenece al universo Tarot & Oráculos entra acá; la clasificación fina de
// abajo decide el resto. Un candidato que no matchea ningún tipo específico
// queda primary_type 'desconocido' — sigue siendo parte del universo (no se
// descarta), pero no se le inventa una categoría.
// ---------------------------------------------------------------------------

const CANDIDATE_RE = /\btarot\b|\btaro\b|\bor[aá]culo|\boracle\b|\blenormand\b|\bkipper\b|\bcartomancia\b|\bcartas?\s+adivinatori|\bbaraja\s+adivinatori|\bmazo\s+de\s+cartas\b.{0,30}\b(tarot|or[aá]culo|adivinat)/i;

// Falsos positivos conocidos y frecuentes en este catálogo: se detectan
// ANTES de aplicar CANDIDATE_RE para no ensuciar el universo con novelas,
// juegos de mesa sin relación esotérica, etc. que sólo comparten una
// palabra suelta ("cartas", "destino").
const KNOWN_FALSE_POSITIVE_RE = /\bcartas?\s+(marcadas|de\s+amor|de\s+navidad|postales?)\b|\bjuego\s+de\s+cartas\b(?!.{0,20}\b(tarot|or[aá]culo))|\bdestino\s+manifiesto\b|\bcarta\s+astral\b.{0,20}\bcurso\b/i;

function isCandidate(text) {
  if (!text) return false;
  if (KNOWN_FALSE_POSITIVE_RE.test(text)) return false;
  return CANDIDATE_RE.test(text);
}

// ---------------------------------------------------------------------------
// Normalización de texto
// ---------------------------------------------------------------------------

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function combinedText(item) {
  return normalizeText([item?.title, item?.description].filter(Boolean).join(' \n '));
}

// ---------------------------------------------------------------------------
// Eje 1 — primary_type. Orden de prioridad explícito: accesorio primero
// (para no clasificar un tapete de tarot como un mazo de tarot), después los
// sistemas más específicos/exclusivos (Lenormand, Kipper) antes que el
// genérico "tarot", y oráculo sólo si no matcheó nada más específico.
// ---------------------------------------------------------------------------

// "estuche" se descartó deliberadamente: en este catálogo describe la caja
// del propio mazo ("Tarot Egipcio (estuche: 78 Cartas Y Libro)"), no un
// accesorio vendido aparte — un caso real encontrado y corregido durante la
// auditoría (ver docs/seo/tarot-merch-tags-audit-*.md), no una suposición.
const ACCESSORY_RE = /\b(tapete|pa[nñ]o|bolsa|atril|soporte|caja\s+de\s+madera|vela\s+ritual|sahumerio|inciensari?o)\b[\s\S]{0,40}\b(tarot|cartas|mazo|or[aá]culo)\b|\b(tarot|cartas|mazo|or[aá]culo)\b[\s\S]{0,40}\b(tapete|pa[nñ]o|bolsa|atril|soporte)\b/;

const LENORMAND_RE = /\blenormand\b/;
const KIPPER_RE = /\bkipper\b/;
const TAROT_RE = /\btarot\b|\btaro\b(?=.{0,25}\bcartas?\b)/;
const ORACULO_RE = /\bor[aá]culo|\boracle\b/;
const OTRO_SISTEMA_RE = /\bcartomancia\b|\bcartas?\s+adivinatori|\bbaraja\s+adivinatori/;

export function classifyPrimaryType(text) {
  if (ACCESSORY_RE.test(text)) return 'accesorio';
  if (LENORMAND_RE.test(text)) return 'lenormand';
  if (KIPPER_RE.test(text)) return 'kipper';
  if (TAROT_RE.test(text)) return 'tarot';
  if (ORACULO_RE.test(text)) return 'oraculo';
  if (OTRO_SISTEMA_RE.test(text)) return 'otro_sistema';
  return 'desconocido';
}

// ---------------------------------------------------------------------------
// Eje 2 — deck_family. Sólo aplica cuando primary_type === 'tarot'. Incluye
// las variantes de tipeo más comunes en catálogos migrados (Rider/Ryder,
// Waite/Wayte), pero exige SIEMPRE el par Rider(-Ryder)+Waite(-Wayte) o una
// forma canónica reconocida ("Universal Waite", "Smith-Waite") — "Waite" o
// "Smith" solos son demasiado ambiguos (apellidos comunes) para contar como
// evidencia.
// ---------------------------------------------------------------------------

const RWS_RE = /r[iy]der[\s-]*wa[iy]te|wa[iy]te[\s-]*smith|smith[\s-]*wa[iy]te|\brws\b|universal\s+wa[iy]te/;
const MARSELLA_RE = /\bmarsell?a\b|\bmarseille\b/;
const THOTH_RE = /\bthoth\b/;

export function classifyDeckFamily(primaryType, text) {
  if (primaryType !== 'tarot') return null;
  if (RWS_RE.test(text)) return 'rider_waite_smith';
  if (MARSELLA_RE.test(text)) return 'marsella';
  if (THOTH_RE.test(text)) return 'thoth';
  return null;
}

// ---------------------------------------------------------------------------
// Eje 3 — format (mazo / libro / accesorio / desconocido) y bundle.
// Un libro SOBRE tarot (teoría, historia, interpretación) no es un mazo,
// aunque hable de tarot todo el tiempo. Señales de libro vs. señales de
// mazo se buscan por separado; si ambas aparecen fuerte, es un bundle
// mazo+guía, no un libro.
// ---------------------------------------------------------------------------

// "libro"/"editorial" (STRONG_BOOK) vienen de casos reales del catálogo:
// listados de libros genuinos en MercadoLibre traen el patrón "De [Autor].
// Editorial [Nombre]" — una señal estructurada y confiable, no una
// intuición (ver docs/seo/tarot-merch-tags-audit-*.md). Es una señal fuerte
// deliberadamente separada de las genéricas: gana por sobre una mención
// suelta de "cartas" en el título de un libro.
const STRONG_BOOK_RE = /\b(libro|editorial)\b/;
const GENERIC_BOOK_RE = /\b(guia|manual|curso|interpretaci[oó]n|significado(s)?\s+de\s+las?\s+cartas|diccionario|c[oó]mo\s+leer|biblia\s+del\s+tarot)\b/;
// STRONG_DECK: mazo/baraja/deck o un conteo explícito de cartas — señal
// inequívoca de producto físico. WEAK_DECK: "cartas"/"cards" sueltas, que
// también aparecen en títulos de libros que hablan DE las cartas — por eso
// nunca gana sola contra una señal fuerte de libro (ver classifyFormat).
const STRONG_DECK_RE = /\bmazo\b|\bbaraja\b|\bdeck\b|\b\d{2,3}\s+cartas\b|\b\d{2,3}\s+cards\b/;
const WEAK_DECK_RE = /\bcartas?\b|\bcards?\b/;
const BUNDLE_RE = /(?:\bcon|\+|\bincluye)\s*(?:libro|gu[ií]a|manual|instructivo)\b|\b(?:libro|gu[ií]a)\s*(?:\+|y)\s*(?:mazo|cartas|baraja)\b|\b(?:mazo|cartas|baraja)\s+y\s+(?:libro|gu[ií]a)\b/;

export function classifyFormat(primaryType, text) {
  if (primaryType === 'accesorio') return 'accesorio';
  const strongBook = STRONG_BOOK_RE.test(text);
  const genericBook = GENERIC_BOOK_RE.test(text);
  const hasBook = strongBook || genericBook;
  const strongDeck = STRONG_DECK_RE.test(text);
  const weakDeck = WEAK_DECK_RE.test(text);

  if (strongDeck) return 'mazo'; // conteo de cartas/mazo/baraja/deck es inequívoco, incluso con señal de libro (bundle)
  if (hasBook) return 'libro';   // "libro"/"editorial"/genéricas ganan por sobre una mención suelta de "cartas"
  if (weakDeck) return 'mazo';   // sólo "cartas"/"cards" suelta, sin nada de libro
  return 'desconocido';
}

export function classifyBundle(format, text) {
  // format ya vino resuelto como 'mazo' por classifyFormat (STRONG_DECK o
  // WEAK_DECK matcheó) — no hace falta repetir esa detección acá.
  if (format !== 'mazo') return 'desconocido';
  return BUNDLE_RE.test(text) ? 'mazo_mas_guia' : 'solo_mazo';
}

// ---------------------------------------------------------------------------
// Eje 4 — level. La mayoría de los listados no lo declaran: 'desconocido'
// (no null) porque es un eje que el usuario pidió explícitamente intentar
// resolver, y "no se pudo resolver" es distinto de "no aplica".
// ---------------------------------------------------------------------------

const BEGINNER_RE = /\bprincipiantes?\b|\biniciaci[oó]n\b|\bpara\s+empezar\b|\bb[aá]sico\b|\bprimeros\s+pasos\b/;
const ADVANCED_RE = /\bavanzad[oa]s?\b|\bprofesional(es)?\b|\bexpert[oa]s?\b|\bexperimentad[oa]s?\b|\bmaestr[ií]a\b/;

export function classifyLevel(text) {
  const beginner = BEGINNER_RE.test(text);
  const advanced = ADVANCED_RE.test(text);
  if (beginner && !advanced) return 'principiante';
  if (advanced && !beginner) return 'avanzado_profesional';
  return 'desconocido'; // incluye el caso "menciona ambos" (ver Light Seer's Tarot) — ambiguo, no se fuerza
}

// ---------------------------------------------------------------------------
// Eje 5 — idioma. Prioridad: bibliographic.language estructurado (cuando
// existe) sobre señal de texto libre. Nunca se asume español por defecto
// sólo porque el sitio es uruguayo.
// ---------------------------------------------------------------------------

const SPANISH_RE = /\bespa[nñ]ol\b|\bcastellano\b|\bidioma\s*:?\s*espa[nñ]ol\b/;
const ENGLISH_RE = /\bingl[eé]s\b|\benglish\b/;
const MULTILANG_RE = /\bbiling[uü]e\b|\bmultiling[uü]e\b|\bmulti[\s-]?idioma\b/;

const KNOWN_BIBLIOGRAPHIC_LANGUAGES = new Map([
  ['espanol', 'espanol'], ['español', 'espanol'], ['castellano', 'espanol'],
  ['ingles', 'ingles'], ['inglés', 'ingles'], ['english', 'ingles'],
]);

export function classifyLanguage(item, text) {
  const structured = normalizeText(item?.bibliographic?.language || '');
  if (structured && KNOWN_BIBLIOGRAPHIC_LANGUAGES.has(structured)) {
    return KNOWN_BIBLIOGRAPHIC_LANGUAGES.get(structured);
  }
  if (MULTILANG_RE.test(text)) return 'multilingue';
  const spanish = SPANISH_RE.test(text);
  const english = ENGLISH_RE.test(text);
  if (spanish && english) return 'multilingue';
  if (spanish) return 'espanol';
  if (english) return 'ingles';
  return 'desconocido';
}

// ---------------------------------------------------------------------------
// Eje 6 — edition_style. Eje opcional: null = sin señal (no es lo mismo que
// "desconocido" en un eje obligatorio — acá simplemente no hay nada que
// marcar).
// ---------------------------------------------------------------------------

const ILLUSTRATED_RE = /\bilustrad[oa]\b|\bedici[oó]n\s+especial\b|\bcoleccionista\b|\bdeluxe\b|\bde\s+lujo\b|\baniversario\b/;
const POCKET_RE = /\bbolsillo\b|\bmini\b|\blata\b|\btin\s+edition\b|\bde\s+viaje\b/;

export function classifyEditionStyle(text) {
  if (ILLUSTRATED_RE.test(text)) return 'ilustrada_especial';
  if (POCKET_RE.test(text)) return 'bolsillo_lata';
  return null;
}

// ---------------------------------------------------------------------------
// Novedades y reposición — ambos ejes se calculan de fuentes ya existentes
// en el catálogo (start_time y, cuando se provee, un snapshot histórico del
// índice pausado), NO del Demand Ledger de DEMAND-LEDGER-1: ese artefacto
// mide impresiones/CTR de Search Console, no altas ni bajas de stock. No
// hay dependencia real entre estos dos lotes.
// ---------------------------------------------------------------------------

const DEFAULT_NEW_ARRIVAL_WINDOW_DAYS = 30;

export function isNewArrival(item, { referenceDate = new Date(), windowDays = DEFAULT_NEW_ARRIVAL_WINDOW_DAYS } = {}) {
  const startTime = item?.start_time ? new Date(item.start_time) : null;
  if (!startTime || Number.isNaN(startTime.getTime())) return false;
  const ageDays = (referenceDate.getTime() - startTime.getTime()) / 86400000;
  return ageDays >= 0 && ageDays <= windowDays;
}

/**
 * Reposición real: un id que estaba en el índice pausado ANTERIOR, ya no
 * está en el índice pausado ACTUAL, y hoy aparece activo con stock. Sin las
 * tres piezas de evidencia, no se marca reposición — nunca se asume.
 */
export function detectRestockedIds({ previousPausedIds = null, currentPausedIds = null, activeItems = [] } = {}) {
  if (!previousPausedIds || !currentPausedIds) return new Set(); // sin evidencia histórica disponible
  const activeIds = new Set(
    activeItems.filter(i => i?.status === 'active' && Number(i.available_quantity) > 0).map(i => i.id),
  );
  const restocked = new Set();
  for (const id of previousPausedIds) {
    if (!currentPausedIds.has(id) && activeIds.has(id)) restocked.add(id);
  }
  return restocked;
}

// ---------------------------------------------------------------------------
// Deduplicación — mismo criterio que paused-seo-cohort: ISBN válido primero
// (raro en mazos, casi siempre null), si no título+autor normalizado. Un
// mazo sin ISBN y sin autor legible no se agrupa con nada (se cuenta solo).
// ---------------------------------------------------------------------------

function isbnKey(item) {
  const digits = String(item?.isbn || '').replace(/\D/g, '');
  return digits.length === 10 || digits.length === 13 ? digits : '';
}

export function dedupeKey(item) {
  const isbn = isbnKey(item);
  if (isbn) return `isbn:${isbn}`;
  const title = normalizeText(item?.title).replace(/[^a-z0-9]+/g, ' ').trim();
  const author = normalizeText(item?.author).replace(/[^a-z0-9]+/g, ' ').trim();
  if (title && author) return `ta:${title}|${author}`;
  return `id:${item?.id}`;
}

// ---------------------------------------------------------------------------
// needs_review — casos deliberadamente sin clasificación firme. Cualquiera
// de estas condiciones basta: mención simultánea de 2+ sistemas distintos,
// primary_type desconocido pese a ser candidato, o format desconocido en un
// candidato claro.
// ---------------------------------------------------------------------------

function countSystemMentions(text) {
  let count = 0;
  if (TAROT_RE.test(text)) count++;
  if (ORACULO_RE.test(text)) count++;
  if (LENORMAND_RE.test(text)) count++;
  if (KIPPER_RE.test(text)) count++;
  return count;
}

export function needsReview({ primaryType, format, text }) {
  if (primaryType === 'desconocido') return { flag: true, reason: 'primary_type desconocido: el título no matchea ningún sistema específico pese a entrar al universo candidato' };
  if (countSystemMentions(text) >= 2) return { flag: true, reason: 'menciona 2 o más sistemas distintos (tarot/oráculo/lenormand/kipper) en el mismo título o descripción' };
  if (primaryType !== 'accesorio' && format === 'desconocido') return { flag: true, reason: 'no se pudo determinar si es un mazo o un libro con las señales de texto disponibles' };
  return { flag: false, reason: null };
}

// ---------------------------------------------------------------------------
// Clasificación de un ítem completo
// ---------------------------------------------------------------------------

export function classifyItem(item, { restockedIds = new Set(), referenceDate = new Date() } = {}) {
  const text = combinedText(item);
  const primaryType = classifyPrimaryType(text);
  const deckFamily = classifyDeckFamily(primaryType, text);
  const format = classifyFormat(primaryType, text);
  const bundle = classifyBundle(format, text);
  const level = classifyLevel(text);
  const language = classifyLanguage(item, text);
  const editionStyle = classifyEditionStyle(text);
  const review = needsReview({ primaryType, format, text });

  return {
    id: item.id,
    title: item.title || null,
    author: item.author || null,
    status: item.status === 'active' ? 'active' : (item.status || 'unknown'),
    stock: item.status === 'active' ? (Number(item.available_quantity) || 0) : null,
    isbn: isbnKey(item) || null,
    primary_type: primaryType,
    deck_family: deckFamily,
    format,
    bundle,
    level,
    language,
    edition_style: editionStyle,
    is_new_arrival: isNewArrival(item, { referenceDate }),
    is_restocked: restockedIds.has(item.id),
    needs_review: review.flag,
    review_reason: review.reason,
  };
}

// ---------------------------------------------------------------------------
// Ensamblado principal — puro, determinista.
// ---------------------------------------------------------------------------

export function buildTarotMerchTags({
  activeItems = [],
  pausedItems = [],
  previousPausedIds = null,
  currentPausedIds = null,
  referenceDate = new Date(),
} = {}) {
  if (!Array.isArray(activeItems)) throw new Error('activeItems debe ser un array.');
  if (!Array.isArray(pausedItems)) throw new Error('pausedItems debe ser un array.');

  const restockedIds = detectRestockedIds({ previousPausedIds, currentPausedIds, activeItems });

  const candidateActive = activeItems.filter(item => item?.id && isCandidate(combinedText(item)));
  const candidatePaused = pausedItems.filter(item => item?.id && isCandidate(combinedText(item)));

  const classifiedActive = candidateActive.map(item => classifyItem(item, { restockedIds, referenceDate }));
  const classifiedPaused = candidatePaused.map(item => classifyItem(item, { restockedIds, referenceDate }));
  const allClassified = [...classifiedActive, ...classifiedPaused];

  // Deduplicación entre activos y pausados: el representante preferido es
  // siempre un activo (comprable ahora); si hay más de uno, el de más stock.
  const groups = new Map();
  for (const row of allClassified) {
    const sourceItem = candidateActive.find(i => i.id === row.id) || candidatePaused.find(i => i.id === row.id);
    const key = dedupeKey(sourceItem);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const representatives = [...groups.values()].map(group => {
    const sorted = [...group].sort((a, b) => {
      const activeA = a.status === 'active' ? 1 : 0;
      const activeB = b.status === 'active' ? 1 : 0;
      if (activeA !== activeB) return activeB - activeA;
      return (b.stock || 0) - (a.stock || 0);
    });
    return { ...sorted[0], duplicate_mlu_count: group.length, duplicate_mlu_ids: group.map(g => g.id) };
  });

  representatives.sort((a, b) => a.id.localeCompare(b.id));

  const counts = {
    total_mlu_bruto: allClassified.length,
    total_mlu_activos_bruto: classifiedActive.length,
    total_mlu_pausados_bruto: classifiedPaused.length,
    productos_unicos: representatives.length,
    por_primary_type: {},
    por_deck_family: {},
    por_format: {},
    por_language: {},
    needs_review_count: representatives.filter(r => r.needs_review).length,
    is_new_arrival_count: representatives.filter(r => r.is_new_arrival).length,
    is_restocked_count: representatives.filter(r => r.is_restocked).length,
    restock_evidence_available: Boolean(previousPausedIds && currentPausedIds),
  };
  for (const row of representatives) {
    counts.por_primary_type[row.primary_type] = (counts.por_primary_type[row.primary_type] || 0) + 1;
    if (row.deck_family) counts.por_deck_family[row.deck_family] = (counts.por_deck_family[row.deck_family] || 0) + 1;
    counts.por_format[row.format] = (counts.por_format[row.format] || 0) + 1;
    counts.por_language[row.language] = (counts.por_language[row.language] || 0) + 1;
  }

  return { rows: representatives, counts };
}

// ---------------------------------------------------------------------------
// Artefacto generado
// ---------------------------------------------------------------------------

export function tarotTagsModuleSource({ rows, metadata }) {
  const serializedRows = rows.map(row => `  Object.freeze(${JSON.stringify(row)}),`);
  return `// Archivo generado por scripts/seo/generate-tarot-merch-tags.mjs.\n` +
    `// No editar a mano: regenerar desde catalog.json + índice pausado.\n` +
    `// Ver docs/seo/tarot-merch-tags-audit-*.md para el inventario forense completo.\n\n` +
    `export const TAROT_MERCH_TAGS_META = Object.freeze(${JSON.stringify(metadata, null, 2)});\n\n` +
    `export const TAROT_MERCH_TAGS = Object.freeze([\n${serializedRows.join('\n')}\n]);\n\n` +
    `const TAROT_MERCH_TAGS_BY_ID = new Map(TAROT_MERCH_TAGS.map(row => [row.id, row]));\n\n` +
    `export function tarotTagForId(id) {\n` +
    `  return TAROT_MERCH_TAGS_BY_ID.get(String(id || '').toUpperCase()) || null;\n` +
    `}\n\n` +
    `/** Filas activas y compra­bles ahora que matchean primary_type/format/deck_family. */\n` +
    `export function tarotTagsMatching({ primaryType, format, deckFamily, language, onlyActive = true } = {}) {\n` +
    `  return TAROT_MERCH_TAGS.filter(row => {\n` +
    `    if (onlyActive && row.status !== 'active') return false;\n` +
    `    if (primaryType && row.primary_type !== primaryType) return false;\n` +
    `    if (format && row.format !== format) return false;\n` +
    `    if (deckFamily && row.deck_family !== deckFamily) return false;\n` +
    `    if (language && row.language !== language) return false;\n` +
    `    return true;\n` +
    `  });\n` +
    `}\n`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function cliOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value) throw new Error(`Falta valor para ${flag}.`);
    if (flag === '--catalog') result.catalog = value;
    else if (flag === '--paused-index') result.pausedIndex = value;
    else if (flag === '--previous-paused-index') result.previousPausedIndex = value;
    else if (flag === '--output') result.output = value;
    else throw new Error(`Argumento desconocido: ${flag}`);
  }
  if (!result.catalog || !result.output) {
    throw new Error(
      'Uso: --catalog catalog.json --output tarot-merch-tags.js ' +
      '[--paused-index paused-index.json] [--previous-paused-index previous-paused-index.json]',
    );
  }
  return result;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function expandCompactPausedIndex(index) {
  const fields = index?.fields || [];
  const idx = { id: fields.indexOf('id'), title: fields.indexOf('title'), author: fields.indexOf('author'), isbn: fields.indexOf('isbn') };
  return (index?.items || []).map(row => ({
    id: row[idx.id],
    title: row[idx.title],
    author: row[idx.author],
    isbn: row[idx.isbn],
    status: 'paused',
    available_quantity: 0,
  }));
}

async function main() {
  const options = cliOptions(process.argv.slice(2));
  const [catalog, pausedIndexRaw, previousPausedIndexRaw] = await Promise.all([
    readJson(options.catalog),
    options.pausedIndex ? readJson(options.pausedIndex) : Promise.resolve(null),
    options.previousPausedIndex ? readJson(options.previousPausedIndex) : Promise.resolve(null),
  ]);

  const activeItems = Array.isArray(catalog.items) ? catalog.items : [];
  const pausedItems = pausedIndexRaw ? expandCompactPausedIndex(pausedIndexRaw) : [];
  const currentPausedIds = pausedIndexRaw ? new Set(expandCompactPausedIndex(pausedIndexRaw).map(i => i.id)) : null;
  const previousPausedIds = previousPausedIndexRaw ? new Set(expandCompactPausedIndex(previousPausedIndexRaw).map(i => i.id)) : null;

  const { rows, counts } = buildTarotMerchTags({
    activeItems, pausedItems, previousPausedIds, currentPausedIds,
  });

  const metadata = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    ...counts,
  };

  await writeFile(options.output, tarotTagsModuleSource({ rows, metadata }));
  console.log(JSON.stringify(metadata, null, 2));
  console.log(`Escrito: ${path.resolve(options.output)}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
