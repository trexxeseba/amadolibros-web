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

  for (const item of sourceItems) {
    const sku = cleanSku(item?.id);
    const reason = rejectionReason(item, sku, seenSku);
    if (reason) {
      rejected.push(rejectRow(item, reason));
      continue;
    }
    seenSku.add(sku);

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
  const title = cleanCell(item.title);
  const author = cleanCell(firstText(
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
  ));

  // El snapshot de R2 guarda el año editorial en bibliographic.publication_year.
  // start_time es el alta del aviso en Mercado Libre, no la fecha de la edición.
  // Si no hay fecha bibliográfica, queda vacía (también en Description).
  const publicationDate = cleanCell(firstText(
    item.year,
    item.publication_year,
    item.publicationDate,
    item.bibliographic?.year,
    item.bibliographic?.publication_year,
    item.bibliographic?.publication_date,
  ));

  // Primera carga: Binding vacío en todas las filas. El catálogo trae valores
  // que no son encuadernación ("Vinilo", "CD", "English", "Papel", "Físico")
  // y Biblio los mostraría como formato. Sin inferencia de Hardcover/Softcover
  // por idioma, categoría ni título: queda para una carga posterior con mapeo
  // explícito. buildDescription no agrega la línea de formato si está vacío.
  const binding = '';

  const language = normalizeLanguage(firstText(
    item.language,
    item.bibliographic?.language,
    item.bibliographic?.idioma,
  ));

  const isbn = normalizeIsbn(item.isbn);
  const quantity = Math.max(1, Math.floor(Number(item.available_quantity) || 1));
  const condition = normalizeCondition(item.condition);
  const price = priceUsd(Number(item.price));
  const description = buildDescription(item, { title, author, publisher, publicationDate, binding, language, isbn, condition });
  const imageUrl = imageUrlFor(sku);
  const keywords = buildKeywords(item, { isbn, language });

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
    Catalog: 'Amado Libros Uruguay',
    Keywords: keywords,
  };
}

function rejectionReason(item, sku, seenSku) {
  if (!sku) return 'missing_sku';
  if (seenSku.has(sku)) return 'duplicate_sku';
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
// o señal bibliográfica: música y video (CDs, vinilos, DVDs). Es un dato de
// categoría de la ficha, no un filtro por título ni por tags. Los mazos de
// tarot/oráculo (MLU-TAROT_CARDS, MLU-BOARD_AND_CARD_GAMES) y las revistas
// (MLU-MAGAZINES) no están acá: siguen entrando. Se aplica siempre, también
// con include_non_books=true.
const EXCLUDED_DOMAIN_SUFFIXES = [
  'MUSIC_ALBUMS',
  'ANTIQUE_MUSIC_ALBUMS',
  'MUSIC_MOVIES_AND_TV_SERIES',
  'PHYSICAL_MOVIES',
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

function buildDescription(item, normalized) {
  const parts = [];
  if (normalized.title) parts.push(`Título: ${normalized.title}.`);
  if (normalized.author && normalized.author !== 'Unknown') parts.push(`Autor: ${normalized.author}.`);
  if (normalized.publisher) parts.push(`Editorial: ${normalized.publisher}.`);
  if (normalized.publicationDate) parts.push(`Fecha/año: ${normalized.publicationDate}.`);
  if (normalized.binding) parts.push(`Encuadernación/formato: ${normalized.binding}.`);
  if (normalized.language) parts.push(`Idioma: ${normalized.language}.`);
  if (normalized.isbn) parts.push(`ISBN: ${normalized.isbn}.`);
  if (Number(item?.pages) > 0) parts.push(`${Number(item.pages)} páginas.`);
  parts.push(`Estado informado por el catálogo: ${normalized.condition}.`);
  parts.push(`SKU Amado/Mercado Libre: ${cleanSku(item?.id)}.`);
  return truncate(parts.join(' '), 3900);
}

function buildKeywords(item, normalized) {
  const values = [
    'Amado Libros',
    'Uruguay',
    normalized.language,
    normalized.isbn ? `ISBN ${normalized.isbn}` : '',
    cleanCell(item?.category_id),
    cleanCell(item?.domain_id),
  ];
  return values.filter(Boolean).join('; ');
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

function imageUrlFor(sku) {
  return `${CANONICAL_BASE}/book-cover/${encodeURIComponent(sku)}/cover.jpg`;
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
