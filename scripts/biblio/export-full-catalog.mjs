#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const CATALOG_URL = process.env.BIBLIO_CATALOG_URL || `${R2_BASE}/catalog.json`;
const PRODUCTION_MANIFEST_URL =
  process.env.BIBLIO_PRODUCTION_MANIFEST_URL || `${R2_BASE}/catalog/manifest.json`;
const OUTPUT_DIR = process.env.BIBLIO_OUTPUT_DIR || 'out/biblio';
const CANONICAL_BASE = (process.env.BIBLIO_CANONICAL_BASE || 'https://www.amadolibros.com')
  .replace(/\/+$/u, '');

const UYU_PER_USD = positiveNumber(process.env.BIBLIO_UYU_PER_USD, 42);
const MARKUP = positiveNumber(process.env.BIBLIO_MARKUP, 1.30);
const MIN_USD = positiveNumber(process.env.BIBLIO_MIN_USD, 12);
const INCLUDE_NON_BOOKS = booleanEnv(process.env.BIBLIO_INCLUDE_NON_BOOKS, false);

const HEADERS = [
  'Book ID',
  'Status (A=add)',
  'Price',
  'Currency',
  'Author',
  'Title',
  'Description',
  'Book Condition',
  'Publisher',
  'Publication Date',
  'ISBN',
  'Binding',
  'Quantity',
  'Language',
  'Image URL',
  'Catalog',
  'Keywords',
  'Image URL 2',
  'Image URL 3',
  'Image URL 4',
  'Image URL 5',
  'Pages',
  'First Edition',
];

const REJECT_HEADERS = [
  'id',
  'title',
  'status',
  'available_quantity',
  'price',
  'currency',
  'isbn',
  'reason',
];

// Todo lo que puede romper una fila en un archivo tab-delimited: tab, CR, LF,
// resto de caracteres de control C0/C1 (incluye \v, \f y NEL U+0085) y los
// separadores Unicode de línea/párrafo (U+2028, U+2029). Se limpian en cada
// celda al escribir, y se vuelven a verificar sobre la línea ya armada (ahí
// el tab es separador legítimo, por eso la segunda expresión lo excluye).
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_CELL_ALL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/gu;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_LINE = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029]/u;

// SKUs ya cargados a mano en Biblio con datos curados (editorial, año, estado
// del ejemplar). No se exportan para que una carga masiva no pise esas fichas.
const SKIP_FILE = new URL('./skip-skus.txt', import.meta.url);
const ALREADY_IN_BIBLIO = new Set(
  (await fs.readFile(SKIP_FILE, 'utf8').catch(() => ''))
    .split(/\r?\n/u)
    .map((line) => line.replace(/#.*$/u, '').trim().toUpperCase())
    .filter((line) => /^MLU\d+$/u.test(line)),
);

// Datos bibliográficos verificados por ISBN (Biblioteca Nacional de España y
// otras bibliotecas nacionales) que el sitio ya usa para las fichas:
// páginas, editorial, año y materias. Se cargan desde functions/_shared.
const VERIFIED_FACTS = await loadVerifiedFacts();

async function loadVerifiedFacts() {
  const dir = new URL('../../functions/_shared/', import.meta.url);
  const map = new Map();
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((name) => /^book-enrichment-facts.*\.js$/u.test(name)).sort();
  } catch {
    return map;
  }
  for (const name of files) {
    try {
      const mod = await import(new URL(name, dir).href);
      for (const entry of mod.BOOK_FACT_ENRICHMENTS || []) {
        const isbn = normalizeIsbn(entry?.isbn);
        if (!isbn || map.has(isbn) || !entry?.facts) continue;
        map.set(isbn, entry.facts);
      }
    } catch (error) {
      console.error(`[biblio-export] no se pudo leer ${name}: ${error.message}`);
    }
  }
  return map;
}

main().catch((error) => {
  console.error(`[biblio-export] ${error.stack || error.message || error}`);
  process.exit(1);
});

async function main() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  const catalog = await fetchJson(CATALOG_URL);
  const sourceItems = Array.isArray(catalog?.items) ? catalog.items : [];
  if (sourceItems.length === 0) {
    throw new Error(`El catálogo no trajo items válidos: ${CATALOG_URL}`);
  }

  const rows = [];
  const rejected = [];
  const seenSku = new Set();
  const isbnGroups = new Map();

  // ISBN de las fichas ya cargadas a mano en Biblio: la otra publicación del
  // mismo libro en Mercado Libre tampoco se exporta, para no duplicarlo.
  const isbnAlreadyInBiblio = new Set(
    sourceItems
      .filter((item) => ALREADY_IN_BIBLIO.has(cleanSku(item?.id)))
      .map((item) => normalizeIsbn(item?.isbn))
      .filter(Boolean),
  );

  const candidates = [];
  for (const item of sourceItems) {
    const sku = cleanSku(item?.id);
    let reason = rejectionReason(item, sku, seenSku);
    if (!reason && isbnAlreadyInBiblio.has(normalizeIsbn(item?.isbn))) {
      reason = 'already_in_biblio_isbn';
    }
    if (reason) {
      rejected.push(rejectRow(item, reason));
      continue;
    }
    seenSku.add(sku);
    candidates.push({ item, sku });
  }

  // Mercado Libre trae el mismo libro dos veces: la publicación propia y la
  // publicación de catálogo (catalog_listing=true), con el mismo stock. A
  // Biblio va una sola fila por libro: si un ISBN tiene al menos una
  // publicación propia, las de catálogo se descartan. Los grupos sin
  // publicación de catálogo no se tocan y quedan en biblio-isbn-duplicates.txt
  // para revisión manual.
  const isbnHasOwnListing = new Set(
    candidates
      .filter(({ item }) => item?.catalog_listing !== true)
      .map(({ item }) => normalizeIsbn(item?.isbn))
      .filter(Boolean),
  );

  for (const { item, sku } of candidates) {
    if (item?.catalog_listing === true && isbnHasOwnListing.has(normalizeIsbn(item?.isbn))) {
      rejected.push(rejectRow(item, 'duplicate_isbn_catalog_listing'));
      continue;
    }

    const row = toBiblioRow(item, sku);
    rows.push(row);

    const normalizedIsbn = normalizeIsbn(item?.isbn);
    if (normalizedIsbn) {
      if (!isbnGroups.has(normalizedIsbn)) isbnGroups.set(normalizedIsbn, []);
      isbnGroups.get(normalizedIsbn).push(sku);
    }
  }

  const pausedInfo = await collectPausedInfo();

  const inventoryPath = path.join(OUTPUT_DIR, 'biblio-amado-full.txt');
  const rejectedPath = path.join(OUTPUT_DIR, 'biblio-rejected.txt');
  const duplicatesPath = path.join(OUTPUT_DIR, 'biblio-isbn-duplicates.txt');
  const summaryPath = path.join(OUTPUT_DIR, 'biblio-summary.json');

  await fs.writeFile(inventoryPath, renderDelimited(HEADERS, rows), 'utf8');
  await fs.writeFile(rejectedPath, renderDelimited(REJECT_HEADERS, rejected), 'utf8');

  const duplicateRows = [...isbnGroups.entries()]
    .filter(([, skus]) => skus.length > 1)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([isbn, skus]) => ({
      isbn,
      count: skus.length,
      skus: skus.join(', '),
    }));

  await fs.writeFile(
    duplicatesPath,
    renderDelimited(['isbn', 'count', 'skus'], duplicateRows),
    'utf8',
  );

  const summary = {
    generated_at: new Date().toISOString(),
    source: {
      catalog_url: CATALOG_URL,
      production_manifest_url: PRODUCTION_MANIFEST_URL,
      canonical_base: CANONICAL_BASE,
    },
    pricing: {
      currency: 'USD',
      uyu_per_usd: UYU_PER_USD,
      markup: MARKUP,
      min_usd: MIN_USD,
      formula: 'max(min_usd, price_UYU / uyu_per_usd * markup)',
    },
    counts: {
      source_items: sourceItems.length,
      exported_rows: rows.length,
      rejected_rows: rejected.length,
      duplicate_isbn_groups: duplicateRows.length,
      paused_seen_not_exported: pausedInfo.count,
    },
    paused_catalog: pausedInfo,
    files: {
      inventory: inventoryPath,
      rejected: rejectedPath,
      duplicates: duplicatesPath,
      summary: summaryPath,
    },
  };

  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify(summary, null, 2));
}

function toBiblioRow(item, sku) {
  const title = cleanTitle(item);
  const verified = VERIFIED_FACTS.get(normalizeIsbn(item.isbn)) || {};
  const author = cleanAuthor(firstText(
    item.author,
    item.authors,
    item.bibliographic?.author,
    item.bibliographic?.authors,
  )) || 'Unknown';

  const publisher = normalizePublisherForBiblio(firstText(
    item.publisher,
    item.editorial,
    item.bibliographic?.publisher,
    item.bibliographic?.editorial,
  )) || normalizePublisherForBiblio(verified.publisher);

  // Año del libro: solo el atributo bibliográfico "Año de publicación" cargado
  // en la ficha, y solo si es un año plausible. Sin fallback a item.start_time
  // (fecha de alta del aviso en Mercado Libre). Sin año real, queda vacío.
  const publicationDate = plausibleYear(firstText(
    item.year,
    item.publication_year,
    item.publicationDate,
    item.bibliographic?.year,
    item.bibliographic?.publication_year,
    item.bibliographic?.publication_date,
    verified.bibliographic?.publication_year,
    verified.publication_year,
  ));

  // Primera carga: Binding vacío en todas las filas. El catálogo trae valores
  // que no son encuadernación ("Vinilo", "CD", "English", "Papel", "Físico")
  // y Biblio los mostraría como formato. Sin inferencia de Hardcover/Softcover
  // por idioma, categoría ni título: queda para una carga posterior con mapeo
  // explícito. buildDescription no agrega la línea de formato si está vacío.
  const binding = explicitBinding(item);

  const language = normalizeLanguage(firstText(
    item.language,
    item.bibliographic?.language,
    item.bibliographic?.idioma,
  ));

  const isbn = normalizeIsbn(item.isbn);
  const quantity = Math.max(1, Math.floor(Number(item.available_quantity) || 1));
  const condition = normalizeCondition(item.condition);
  const price = priceUsd(Number(item.price));
  const pages = Number(item.pages) > 0 ? Number(item.pages)
    : Number(verified.pages) > 0 ? Number(verified.pages)
      : pagesFromText(item);
  const subjects = Array.isArray(verified.bibliographic?.subjects) ? verified.bibliographic.subjects : [];
  const theme = themeFor(item, { language });
  const description = buildDescription(item, { title, author, publisher, publicationDate, binding, language, isbn, condition, pages, theme });
  const imageUrl = imageUrlFor(sku);
  const pictureCount = Array.isArray(item.pictures) ? item.pictures.length : 1;
  const extraImages = [2, 3, 4, 5].map((position) => (position <= pictureCount ? imageUrlFor(sku, position) : ''));
  const firstEdition = /primera edicion|1a edicion|1ª edicion|first edition/u.test(itemText(item)) ? '1' : '0';
  const keywords = buildKeywords(item, { isbn, language, author, publisher, subjects, theme });

  return {
    'Book ID': sku,
    'Status (A=add)': 'A',
    Price: price.toFixed(2),
    Currency: 'USD',
    Author: author,
    Title: title,
    Description: description,
    'Book Condition': condition,
    Publisher: publisher,
    'Publication Date': publicationDate,
    ISBN: isbn,
    Binding: binding,
    Quantity: String(quantity),
    Language: language,
    'Image URL': imageUrl,
    Catalog: theme.catalog,
    Keywords: keywords,
    'Image URL 2': extraImages[0],
    'Image URL 3': extraImages[1],
    'Image URL 4': extraImages[2],
    'Image URL 5': extraImages[3],
    Pages: pages ? String(pages) : '',
    'First Edition': firstEdition,
  };
}

function rejectionReason(item, sku, seenSku) {
  if (!sku) return 'missing_sku';
  if (seenSku.has(sku)) return 'duplicate_sku';
  if (ALREADY_IN_BIBLIO.has(sku)) return 'already_in_biblio';
  if (!cleanCell(item?.title)) return 'missing_title';
  if (String(item?.status || '').trim().toLowerCase() !== 'active') return 'not_active';
  if (!(Number(item?.available_quantity) > 0)) return 'no_stock';
  if (!(Number(item?.price) > 0)) return 'missing_or_invalid_price';
  const currency = String(item?.currency || item?.currency_id || '').trim().toUpperCase();
  if (currency && currency !== 'UYU') return `unsupported_currency_${currency}`;
  if (isExcludedDomain(item)) return 'non_book_domain';
  if (!INCLUDE_NON_BOOKS && !isLikelyBook(item)) return 'not_book_signal';
  return null;
}

// Dominios de Mercado Libre que nunca van a Biblio aunque la ficha traiga ISBN
// o señal bibliográfica: música y video (CDs, vinilos, DVDs) y juegos de mesa
// (MLU-BOARD_AND_CARD_GAMES: puzzles, dominós, trivias; no trae mazos de
// tarot). Es un dato de categoría de la ficha, no un filtro por título ni por
// tags. Los mazos de tarot/oráculo (MLU-TAROT_CARDS) y las revistas
// (MLU-MAGAZINES) no están acá: siguen entrando. Se aplica siempre, también
// con include_non_books=true.
const EXCLUDED_DOMAIN_SUFFIXES = [
  'MUSIC_ALBUMS',
  'ANTIQUE_MUSIC_ALBUMS',
  'MUSIC_MOVIES_AND_TV_SERIES',
  'PHYSICAL_MOVIES',
  'BOARD_AND_CARD_GAMES',
];

function isExcludedDomain(item) {
  const domain = String(item?.domain_id || '').trim().toUpperCase();
  if (!domain) return false;
  const suffix = domain.replace(/^MLU-/u, '');
  return EXCLUDED_DOMAIN_SUFFIXES.includes(suffix);
}

function isLikelyBook(item) {
  const domain = String(item?.domain_id || '').trim().toUpperCase();
  if (/(?:^|[-_])BOOKS(?:$|[-_])/.test(domain)) return true;
  // Los mazos de tarot/oráculo van a Biblio junto con los libros aunque la
  // ficha no traiga autor, ISBN ni datos bibliográficos.
  if (domain.replace(/^MLU-/u, '') === 'TAROT_CARDS') return true;
  if (normalizeIsbn(item?.isbn)) return true;
  const bibliographic = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const bibliographicValues = Object.values(bibliographic).filter((value) => cleanCell(value));
  if (bibliographicValues.length >= 1) return true;
  const signals = [
    cleanCell(item?.author),
    cleanCell(item?.publisher),
    Number(item?.pages) > 0,
  ].filter(Boolean).length;
  return signals >= 2;
}

// La descripción de Biblio se arma con el texto de la ficha de Mercado Libre
// (sinopsis, autor, reseña) más una ficha técnica al final. Del texto de
// Mercado Libre se quitan las líneas pensadas para el comprador uruguayo
// (envíos, retiro, WhatsApp, "por encargo", cierre de marca, precios), que a
// un comprador internacional no le dicen nada o lo confunden. Si no queda
// texto útil, va solo la ficha técnica.
const LOCAL_LINE_PATTERNS = [
  /por encargo/u,
  /amado libros/u,
  /somos amado|en amado\b|equipo amado/u,
  /amado vintage/u,
  /whats?app|wsp\b/u,
  /mercado ?libre|mercado ?pago|mercado ?envios|tienda oficial|mercado lider/u,
  /\benvio|\benvios\b|\bflex\b|correo\b|\bcadete/u,
  /retir[aáo]/u,
  /factura|garantia|devolucion/u,
  /consult[aáe]/u,
  /\bstock\b|disponib|demora|plazo|dias habiles|\bentrega|coordin/u,
  /a las ordenes|seguinos|instagram|facebook|\bweb\b|www\.|https?:/u,
  /\bpago\b|cuotas|precio|oferta|promo|descuento|\$|\busd\b|\buyu\b|pesos/u,
  /uruguay|montevideo|interior del pais/u,
  /\bpedido|importa(?:do|mos|cion)|traemos|conseguimos|encarg/u,
  /\bsku\b|\bmlu\d+/u,
  /\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3}/u,
];

function cleanMarketplaceDescription(raw, normalized) {
  const text = String(raw || '');
  if (!text.trim()) return '';
  const kept = [];
  const titleKey = foldKey(normalized.title);
  for (const line of text.split(/\r?\n+/u)) {
    const clean = cleanCell(line.replace(/^[\s\-•·*–—>]+/u, ''));
    if (!clean || clean.length < 3) continue;
    const key = foldKey(clean);
    if (LOCAL_LINE_PATTERNS.some((pattern) => pattern.test(key))) continue;
    if (key === titleKey) continue;
    if (/^[\p{So}\p{P}\s]+$/u.test(clean)) continue;
    kept.push(/[.!?:;…)]$/u.test(clean) ? clean : `${clean}.`);
  }
  return kept.join(' ');
}

function foldKey(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function buildTechnicalSheet(item, normalized) {
  const bibliographic = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const parts = [];
  if (normalized.author && normalized.author !== 'Unknown') parts.push(`Autor: ${normalized.author}.`);
  if (normalized.publisher) parts.push(`Editorial: ${normalized.publisher}.`);
  const collection = cleanCell(bibliographic.collection);
  if (collection) parts.push(`Colección: ${collection}.`);
  if (normalized.publicationDate) parts.push(`Año de publicación: ${normalized.publicationDate}.`);
  if (normalized.binding) parts.push(`Encuadernación: ${normalized.binding === 'Hardcover' ? 'tapa dura' : 'tapa blanda'}.`);
  if (normalized.language) parts.push(`Idioma: ${normalized.language}.`);
  if (normalized.pages) parts.push(`${normalized.pages} páginas.`);
  const size = formatDimensions(item?.dimensions);
  if (size) parts.push(`Medidas: ${size}.`);
  const genre = cleanCell(bibliographic.genre);
  const themes = (normalized.theme?.themes || []).filter((t) => !/^(Spanish-language books|Libros en español)$/u.test(t)).slice(0, 4);
  if (genre || themes.length) parts.push(`Materia: ${[genre, themes.join(', ')].filter(Boolean).join(' / ')}.`);
  if (normalized.isbn) parts.push(`ISBN: ${normalized.isbn}.`);
  if (normalized.condition === 'Used') {
    const detail = conditionFromText(item);
    parts.push(detail ? `Estado del ejemplar: ${detail}` : 'Ejemplar usado; ver fotografías.');
  } else {
    parts.push('Ejemplar nuevo.');
  }
  parts.push(`Referencia: ${cleanSku(item?.id)}.`);
  return parts.join(' ');
}

// Título: la ficha de Mercado Libre antepone "Libro" o "Libro -" y a veces
// cierra con "- Usado" para su buscador; en Biblio sobra. Se prefiere la
// versión con mayúsculas corregidas (showcase_display_title) cuando existe.
function cleanTitle(item) {
  const raw = cleanCell(item?.showcase_display_title) || cleanCell(item?.title);
  return raw
    .replace(/^(?:libro|libros)\s*[:\-–—]?\s+(?!(?:de|del|para|sobre|con|en|y|e|o|a|al)\b)/iu, '')
    .replace(/\s*[\-–—(]\s*usado\s*\)?\s*$/iu, '')
    .replace(/\s*\(cartone\)\s*/iu, ' ')
    .replace(/\s*[\-–—]\s*tapa (?:dura|blanda)\s*$/iu, '')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .replace(/^\p{Ll}/u, (ch) => ch.toUpperCase()) || cleanCell(item?.title);
}

// Autor en mayúsculas sostenidas ("JIM KWIK") pasa a capitalizado. Solo si
// toda la cadena está en mayúsculas; el resto se respeta tal cual.
function cleanAuthor(value) {
  const clean = cleanCell(value);
  if (!clean) return '';
  if (clean.length > 3 && clean === clean.toUpperCase() && clean !== clean.toLowerCase()) {
    return clean.toLowerCase().replace(/(^|[\s\-'(.,])(\p{L})/gu, (m, pre, ch) => pre + ch.toUpperCase())
      .replace(/\b(De|Del|La|Las|Los|Y|E|Van|Von|Da|Di|Le|Du)\b/gu, (m) => m.toLowerCase());
  }
  return clean;
}

function itemText(item) {
  return foldKey(`${item?.title || ''} ${item?.description || ''}`);
}

// Encuadernación solo cuando la propia ficha lo dice; sin inferir.
function explicitBinding(item) {
  const text = itemText(item);
  const hard = /tapa dura|cartone|hardcover|encuadernado en tela/u.test(text);
  const soft = /tapa blanda|rustica|paperback|softcover/u.test(text);
  if (hard && !soft) return 'Hardcover';
  if (soft && !hard) return 'Softcover';
  return '';
}

function pagesFromText(item) {
  const match = itemText(item).match(/\b(\d{2,4})\s*(?:paginas|pags?\b|pp\b)/u);
  if (!match) return 0;
  const n = Number(match[1]);
  return n >= 16 && n <= 3000 ? n : 0;
}

// Para usados: la frase de la ficha que describe el estado, si la hay.
function conditionFromText(item) {
  const text = cleanCell(item?.description);
  if (!text) return '';
  const sentences = text.split(/(?<=[.!?])\s+|\s*\n+\s*/u);
  const hits = sentences.filter((sentence) => {
    const key = foldKey(sentence);
    return /\b(estado|desgaste|manch|subray|anotaci|lomo|hojas amarill|amarillent|sobrecubierta|rotur|falta|intacto|conservad)/u.test(key)
      && !LOCAL_LINE_PATTERNS.some((pattern) => pattern.test(key))
      && sentence.length <= 300;
  });
  if (!hits.length) return '';
  const detail = hits.slice(0, 2).join(' ').trim();
  return /[.!?]$/u.test(detail) ? detail : `${detail}.`;
}

function formatDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'object') return '';
  const values = ['height', 'width', 'depth']
    .map((key) => cleanCell(dimensions[key]))
    .filter(Boolean);
  return values.join(' x ');
}

function buildDescription(item, normalized) {
  const sheet = buildTechnicalSheet(item, normalized);
  const closing = closingCopy(normalized);
  const limit = 4500;
  const tail = `${sheet} ${closing}`;
  const narrative = cleanMarketplaceDescription(item?.description, normalized);
  if (!narrative || narrative.length < 40) {
    return `${normalized.title}. ${tail}`.slice(0, limit).trim();
  }
  const room = limit - tail.length - 1;
  return `${truncate(narrative, Math.max(room, 200))} ${tail}`.slice(0, limit).trim();
}

function plausibleYear(raw) {
  const match = String(raw || '').match(/\b(1[4-9]\d{2}|20\d{2})\b/u);
  if (!match) return '';
  const year = Number(match[1]);
  const maxYear = new Date().getUTCFullYear() + 1;
  return year >= 1450 && year <= maxYear ? String(year) : '';
}

// Temáticas en inglés para el comprador de Biblio (EEUU, Reino Unido) a
// partir del género de la ficha de Mercado Libre, el dominio y el título.
// `catalog` sigue la taxonomía de navegación de Biblio; `themes` son
// palabras clave temáticas que se suman a Keywords. Sin género conocido,
// se cae al dominio y al idioma.
const THEME_RULES = [
  [/tarot|oraculo|adivinacion|cartomancia|lenormand/u, ['Tarot', 'Divination', 'Oracle Cards', 'New Age'], 'Religion, Philosophy and Metaphysics'],
  [/esoter|astrolog|magia|ocultismo|espiritualidad|new age|reiki|chakra|angeles/u, ['Esoterica', 'Occult', 'Spirituality', 'New Age', 'Body, Mind & Spirit'], 'Religion, Philosophy and Metaphysics'],
  [/religion|biblia|cristian|catolic|teolog|oracion|santos/u, ['Religion', 'Christianity', 'Bible', 'Theology'], 'Religion, Philosophy and Metaphysics'],
  [/psicoanalisis|lacan|freud/u, ['Psychoanalysis', 'Psychology', 'Lacan', 'Freud'], 'Social Sciences, Biography and Genealogy'],
  [/psicolog|psicoterap|psiquiatr|psicomotric/u, ['Psychology', 'Psychotherapy', 'Mental Health'], 'Social Sciences, Biography and Genealogy'],
  [/filosofia/u, ['Philosophy'], 'Religion, Philosophy and Metaphysics'],
  [/autoayuda|desarrollo personal|crecimiento personal|motivacion/u, ['Self-Help', 'Personal Development', 'Motivation'], 'Social Sciences, Biography and Genealogy'],
  [/infantil|cuentos|album ilustrado|primeros lectores/u, ['Children\'s Books', 'Picture Books', 'Kids'], 'Children\'s Books'],
  [/juvenil|young adult/u, ['Young Adult', 'Teen Fiction'], 'Children\'s Books'],
  [/manga|comic|novela grafica|historieta/u, ['Manga', 'Comics', 'Graphic Novels'], 'Literature'],
  [/poesia/u, ['Poetry'], 'Literature'],
  [/novela|ficcion|literatura|narrativa|cuento|relatos|teatro|clasicos/u, ['Literature', 'Fiction', 'Novel'], 'Literature'],
  [/historia|arqueolog|militar|guerra|uruguay/u, ['History', 'World History', 'Latin American History'], 'History'],
  [/biografia|memoria|autobiografia/u, ['Biography', 'Memoir'], 'Social Sciences, Biography and Genealogy'],
  [/derecho|politica|sociolog|antropolog|ciencias sociales|humanidades|economia|genero|feminismo/u, ['Social Sciences', 'Politics', 'Sociology', 'Law'], 'Social Sciences, Biography and Genealogy'],
  [/negocios|finanzas|marketing|empresa|management|liderazgo|emprend/u, ['Business', 'Finance', 'Management', 'Leadership'], 'Business, Finance and the Law'],
  [/salud|medicina|enfermeria|nutricion|bienestar|anatomia|fisioterap|odontolog|veterinar/u, ['Health', 'Medicine', 'Wellness', 'Nursing'], 'Science, Technology and Transportation'],
  [/crianza|familia|embarazo|maternidad|paternidad|bebe/u, ['Parenting', 'Family', 'Pregnancy', 'Childcare'], 'Social Sciences, Biography and Genealogy'],
  [/educacion|pedagog|escuela|docente|didactica|montessori|texto|academico|universitario|idiomas|ingles/u, ['Education', 'Teaching', 'Textbooks', 'Pedagogy'], 'Social Sciences, Biography and Genealogy'],
  [/arte|cine|fotograf|diseno|arquitectura|moda|dibujo|pintura/u, ['Art', 'Design', 'Photography', 'Film', 'Architecture'], 'The Arts'],
  [/musica|rock|jazz|tango|guitarra|partitura/u, ['Music'], 'The Arts'],
  [/gastronomia|cocina|recetas|vino|reposteria/u, ['Cooking', 'Food & Wine', 'Recipes'], 'Cooking, Gardening and Domestic Arts'],
  [/manualidades|tejido|crochet|costura|jardin|hogar|decoracion|bricolaje/u, ['Crafts', 'Hobbies', 'Gardening', 'Home'], 'Cooking, Gardening and Domestic Arts'],
  [/deporte|futbol|ajedrez|yoga|fitness|caballo|equitacion|pesca|caza/u, ['Sports', 'Games', 'Recreation', 'Horses'], 'Sports, Games and Recreation'],
  [/humor|satir/u, ['Humor', 'Satire'], 'Literature'],
  [/ciencia|matematica|fisica|quimica|biolog|astronom|tecnolog|informatica|programacion|ingenieria|naturaleza|animales|aves|botanica/u, ['Science', 'Nature', 'Technology', 'Mathematics'], 'Science, Technology and Transportation'],
  [/viaje|turismo|guia|mapa|atlas|geografia/u, ['Travel', 'Geography', 'Maps'], 'Travel and Exploration'],
  [/diccionario|enciclopedia|consulta|referencia/u, ['Reference', 'Dictionaries', 'Encyclopedias'], 'Everything Else'],
  [/revista|periodic|magazine/u, ['Magazines', 'Periodicals', 'Ephemera'], 'Ephemera'],
];

function themeFor(item, normalized) {
  const bibliographic = item?.bibliographic && typeof item.bibliographic === 'object' ? item.bibliographic : {};
  const domain = String(item?.domain_id || '').toUpperCase();
  const genreKey = foldKey(`${bibliographic.genre || ''} ${bibliographic.collection || ''}`);
  const titleKey = foldKey(item?.title);
  const themes = [];
  let catalog = '';
  const apply = (text, max) => {
    for (const [pattern, words, cat] of THEME_RULES) {
      if (!pattern.test(text)) continue;
      for (const w of words) if (!themes.includes(w)) themes.push(w);
      if (!catalog) catalog = cat;
      if (themes.length >= max) break;
    }
  };
  if (domain.endsWith('TAROT_CARDS')) { apply('tarot', 9); }
  if (domain.endsWith('MAGAZINES')) { apply('revista', 9); }
  apply(genreKey, 9);
  if (!catalog) apply(titleKey, 6);
  if (!catalog) catalog = normalized.language === 'Spanish' ? 'Books in Spanish' : 'Everything Else';
  const subjects = Array.isArray(bibliographic.subjects) ? bibliographic.subjects : [];
  for (const subject of subjects.slice(0, 3)) {
    const w = cleanCell(subject).replace(/\s+—.*$/u, '');
    if (w && !themes.includes(w)) themes.push(w);
  }
  if (normalized.language === 'Spanish') {
    for (const w of ['Spanish-language books', 'Libros en español']) if (!themes.includes(w)) themes.push(w);
  }
  if (/uruguay|montevideo|rioplatense|charrua/u.test(titleKey) || /uruguay/u.test(genreKey)) {
    for (const w of ['Uruguay', 'Latin America', 'Río de la Plata']) if (!themes.includes(w)) themes.push(w);
  }
  return { catalog, themes };
}

function buildKeywords(item, normalized) {
  const bibliographic = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const values = [
    normalized.author && normalized.author !== 'Unknown' ? normalized.author : '',
    normalized.publisher,
    cleanCell(bibliographic.genre),
    cleanCell(bibliographic.collection),
    ...(normalized.theme?.themes || []),
    ...(normalized.subjects || []).slice(0, 3).map((v) => cleanCell(v).replace(/\s+—.*$/u, '')),
    normalized.language,
    normalized.isbn ? `ISBN ${normalized.isbn}` : '',
    'Amado Libros',
  ];
  return [...new Set(values.filter(Boolean))].join('; ');
}

function normalizeCondition(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'new') return 'New';
  if (value === 'used') return 'Used';
  return cleanCell(raw) || 'Used';
}

// Mercado Libre devuelve como editorial valores que no lo son: "AMADO LIBROS"
// (el vendedor) y "Genérica"/"Genérico" (placeholder de marca de la ficha).
// Para Biblio son datos falsos: quedan vacíos, tanto en la columna Publisher
// como en la línea "Editorial:" de Description. No se inventa editorial
// sustituta. La comparación es en mayúsculas y sin acentos ni espacios dobles,
// para no depender de la variante que traiga cada ficha.
const PLACEHOLDER_PUBLISHERS = new Set([
  'AMADO LIBROS',
  'GENERICA',
  'GENERICO',
]);

function publisherKey(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toUpperCase()
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizePublisherForBiblio(value) {
  const clean = cleanCell(value);
  if (!clean) return '';
  if (PLACEHOLDER_PUBLISHERS.has(publisherKey(clean))) return '';
  return clean;
}

function normalizeLanguage(raw) {
  const value = cleanCell(raw);
  if (!value) return '';
  const key = value.toLowerCase();
  const map = new Map([
    ['es', 'Spanish'],
    ['spa', 'Spanish'],
    ['spanish', 'Spanish'],
    ['español', 'Spanish'],
    ['espanol', 'Spanish'],
    ['castellano', 'Spanish'],
    ['en', 'English'],
    ['eng', 'English'],
    ['english', 'English'],
    ['inglés', 'English'],
    ['ingles', 'English'],
    ['inglés internacional', 'English'],
    ['ingles internacional', 'English'],
    ['inglés americano', 'English'],
    ['ingles americano', 'English'],
    ['inglés británico', 'English'],
    ['ingles britanico', 'English'],
    ['fr', 'French'],
    ['fre', 'French'],
    ['fra', 'French'],
    ['french', 'French'],
    ['francés', 'French'],
    ['frances', 'French'],
    ['de', 'German'],
    ['ger', 'German'],
    ['deu', 'German'],
    ['german', 'German'],
    ['alemán', 'German'],
    ['aleman', 'German'],
    ['it', 'Italian'],
    ['ita', 'Italian'],
    ['italian', 'Italian'],
    ['italiano', 'Italian'],
    ['pt', 'Portuguese'],
    ['por', 'Portuguese'],
    ['portuguese', 'Portuguese'],
    ['portugués', 'Portuguese'],
    ['portugues', 'Portuguese'],
  ]);
  return map.get(key) || value;
}

// Misma convención que el feed de Merchant: cover.jpg es la primera foto de
// la ficha y cover-N.jpg la enésima, servidas por el sitio.
function imageUrlFor(sku, position = 1) {
  const file = position <= 1 ? 'cover.jpg' : `cover-${position}.jpg`;
  return `${CANONICAL_BASE}/book-cover/${encodeURIComponent(sku)}/${file}`;
}

// Cierre de cada descripción para el comprador de Biblio (EEUU, Reino Unido,
// Europa): idioma de la edición, origen y envío con seguimiento, embalaje,
// búsqueda por encargo y agradecimiento. Primero en inglés, después en
// español. Sin teléfono ni web: Biblio no admite datos de contacto en fichas.
const EDITION_LINE = new Map([
  ['Spanish', ['Spanish-language edition.', 'Edición en español.']],
  ['English', ['English-language edition.', 'Edición en inglés.']],
  ['French', ['French-language edition.', 'Edición en francés.']],
  ['Italian', ['Italian-language edition.', 'Edición en italiano.']],
  ['Portuguese', ['Portuguese-language edition.', 'Edición en portugués.']],
  ['German', ['German-language edition.', 'Edición en alemán.']],
]);

function closingCopy(normalized) {
  const [en, es] = EDITION_LINE.get(normalized.language) || ['', ''];
  const used = normalized.condition === 'Used';
  const english = [
    en,
    used ? 'Please check the photos for the condition of this copy.' : '',
    'Ships from Uruguay with full tracking. Every book is individually wrapped with care and securely packed so it reaches you in excellent condition. Looking for a title you can\'t find? We source books on request. Thank you for letting us serve you. Amado Libros, Montevideo.',
  ].filter(Boolean).join(' ');
  const spanish = [
    es,
    used ? 'Las fotos muestran el estado real de este ejemplar.' : '',
    'Enviamos desde Uruguay con seguimiento completo. Cada libro va envuelto con cuidado y bien protegido para que llegue a sus manos en excelentes condiciones. ¿Busca un título que no encuentra? Conseguimos libros por encargo. Gracias por permitirnos servirle. Amado Libros, Montevideo.',
  ].filter(Boolean).join(' ');
  return `${english} ${spanish}`;
}

function priceUsd(priceUyu) {
  const raw = (priceUyu / UYU_PER_USD) * MARKUP;
  const capped = Math.max(MIN_USD, raw);
  return Math.ceil(capped * 100) / 100;
}

function rejectRow(item, reason) {
  return {
    id: cleanSku(item?.id),
    title: cleanCell(item?.title),
    status: cleanCell(item?.status),
    available_quantity: cleanCell(item?.available_quantity),
    price: cleanCell(item?.price),
    currency: cleanCell(item?.currency || item?.currency_id),
    isbn: cleanCell(item?.isbn),
    reason,
  };
}

async function collectPausedInfo() {
  try {
    const manifest = await fetchJson(PRODUCTION_MANIFEST_URL);
    const descriptors = [manifest?.current, manifest?.previous].filter(validDescriptor);
    for (const descriptor of descriptors) {
      const index = await fetchIndexDescriptor(descriptor);
      const items = expandPausedIndex(index);
      if (items) {
        const sample = items.slice(0, 20).map((item) => ({
          id: item.id,
          title: item.title,
          isbn: item.isbn || null,
        }));
        return {
          available: true,
          version: descriptor.version || null,
          count: items.length,
          note: 'Pausados/por encargo detectados pero no exportados a Biblio porque no traen precio publicable.',
          sample,
        };
      }
    }
  } catch (error) {
    return {
      available: false,
      count: 0,
      error: String(error?.message || error).slice(0, 300),
    };
  }
  return { available: false, count: 0 };
}

async function fetchIndexDescriptor(descriptor) {
  if (typeof descriptor.index_gzip_key === 'string' && descriptor.index_gzip_key.endsWith('/index.json.gz')) {
    const bytes = await fetchBytes(`${R2_BASE}/${descriptor.index_gzip_key}`);
    return JSON.parse(gunzipSync(bytes).toString('utf8'));
  }
  if (typeof descriptor.index_key === 'string') {
    return fetchJson(`${R2_BASE}/${descriptor.index_key}`);
  }
  return null;
}

function expandPausedIndex(index) {
  const expectedFields = ['id', 'title', 'author', 'isbn', 'image'];
  if (!index || index.schema_version !== 1 || !Array.isArray(index.items)) return null;
  if (JSON.stringify(index.fields) !== JSON.stringify(expectedFields)) return null;
  return index.items
    .filter((row) => Array.isArray(row) && row.length === expectedFields.length)
    .map(([id, title, author, isbn, image]) => ({
      id,
      title,
      author,
      isbn,
      image,
    }));
}

function validDescriptor(value) {
  return value &&
    typeof value === 'object' &&
    typeof value.version === 'string' &&
    typeof value.index_key === 'string' &&
    typeof value.block_prefix === 'string' &&
    Number.isInteger(value.block_count) &&
    value.block_count >= 1;
}

function renderDelimited(headers, rows) {
  const lines = [headers.join('\t')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeTsv(row[header] ?? '')).join('\t'));
  }
  assertDelimited(headers, lines);
  return `${lines.join('\n')}\n`;
}

// Última barrera antes de escribir el TXT: cada línea debe tener exactamente
// las columnas del header y ningún carácter de salto/tab dentro de una celda.
// Si falla, el script termina con error y el workflow no sube nada a Biblio.
function assertDelimited(headers, lines) {
  const expected = headers.length;
  const problems = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FORBIDDEN_IN_LINE.test(line)) {
      problems.push(`línea ${i + 1}: contiene carácter de salto de línea o control`);
    }
    const columns = line.split('\t').length;
    if (columns !== expected) {
      problems.push(`línea ${i + 1}: ${columns} columnas, se esperaban ${expected}`);
    }
    if (problems.length >= 10) break;
  }
  if (problems.length > 0) {
    throw new Error(`TSV inválido para Biblio:\n${problems.join('\n')}`);
  }
}

function escapeTsv(value) {
  return String(value ?? '')
    .replace(FORBIDDEN_IN_CELL_ALL, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function cleanSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  return /^MLU\d+$/.test(sku) ? sku : '';
}

function cleanCell(value) {
  if (Array.isArray(value)) return cleanCell(value.filter(Boolean).join(', '));
  if (value == null) return '';
  if (typeof value === 'object') return '';
  return String(value)
    .replace(FORBIDDEN_IN_CELL_ALL, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim();
}

function firstText(...values) {
  for (const value of values) {
    const cleaned = cleanCell(value);
    if (cleaned) return cleaned;
  }
  return '';
}

function truncate(text, limit) {
  const clean = cleanCell(text);
  if (clean.length <= limit) return clean;
  const clipped = clean.slice(0, limit + 1);
  const boundary = clipped.lastIndexOf(' ');
  return clipped.slice(0, boundary >= Math.floor(limit * 0.7) ? boundary : limit).trim();
}

function normalizeIsbn(raw) {
  const cleaned = String(raw || '')
    .trim()
    .toUpperCase()
    .replace(/^ISBN(?:-1[03])?:?\s*/u, '')
    .replace(/[\s-]+/gu, '');
  if (isValidIsbn13(cleaned) || isValidIsbn10(cleaned)) return cleaned;
  return '';
}

function isValidIsbn13(digits) {
  if (!/^(978|979)\d{10}$/u.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(digits[i]) * (i % 2 === 0 ? 1 : 3);
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[12]);
}

function isValidIsbn10(value) {
  if (!/^\d{9}[\dX]$/u.test(value)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i += 1) sum += Number(value[i]) * (10 - i);
  sum += value[9] === 'X' ? 10 : Number(value[9]);
  return sum % 11 === 0;
}

async function fetchJson(url) {
  const bytes = await fetchBytes(url);
  return JSON.parse(bytes.toString('utf8'));
}

async function fetchBytes(url) {
  const response = await fetch(url, { headers: { 'Accept-Encoding': 'identity' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} al leer ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function positiveNumber(raw, fallback) {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanEnv(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'si', 'sí'].includes(String(raw).trim().toLowerCase());
}
