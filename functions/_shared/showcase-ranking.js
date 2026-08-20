// FICHAS-VIDRIERA-1000: selección comercial determinista de ediciones activas.
// No inventa demanda ni contenido. Ordena únicamente señales reales del catálogo.

export const DEFAULT_SHOWCASE_LIMIT = 1000;

const GENERIC_AUTHORS = new Set([
  'anónimo',
  'anonimo',
  'autor',
  'autores',
  'autor no especificado',
  'no aplica',
  'n/a',
  's/a',
  'sin autor',
  'varios',
  'varios autores',
  'vv aa',
  'vv. aa.',
]);

const PLACEHOLDER_PUBLISHERS = new Set([
  'amado libros',
  'amado libros uruguay',
  'sin editorial',
  'no aplica',
  'n/a',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es');
}

function isbn13Checksum(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!/^(978|979)\d{10}$/.test(digits)) return false;
  const sum = [...digits.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return Number(digits[12]) === (10 - (sum % 10)) % 10;
}

function isbn10Checksum(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (!/^\d{9}[0-9X]$/.test(raw)) return false;
  const sum = [...raw].reduce((total, digit, index) => {
    const number = digit === 'X' ? 10 : Number(digit);
    return total + number * (10 - index);
  }, 0);
  return sum % 11 === 0;
}

export function normalizeValidIsbn(value) {
  const raw = String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
  if (/^\d{13}$/.test(raw) && isbn13Checksum(raw)) return raw;
  if (!isbn10Checksum(raw)) return null;

  const base = `978${raw.slice(0, 9)}`;
  const sum = [...base].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${base}${(10 - (sum % 10)) % 10}`;
}

export function isGenericAuthor(value) {
  const key = normalizedText(value);
  return !key || GENERIC_AUTHORS.has(key);
}

function realPublisher(value) {
  const key = normalizedText(value);
  return Boolean(key) && !PLACEHOLDER_PUBLISHERS.has(key);
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function descriptionLength(item) {
  return clean(item?.description).length;
}

function pictureCount(item) {
  const sources = [
    ...(Array.isArray(item?.pictures) ? item.pictures : []),
    item?.thumbnail,
  ].filter(Boolean);
  return new Set(sources.map(value => clean(value))).size;
}

function fieldCount(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  return Object.values(value).filter(field => clean(field)).length;
}

function validDate(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
}

function validCurrency(item) {
  return clean(item?.currency || item?.currency_id).toUpperCase() === 'UYU';
}

// Mismo contrato de libro que usa Merchant: un dominio BOOKS basta; con un
// dominio de otra familia se exige ISBN válido + otra señal; sin dominio se
// exige ISBN o dos señales bibliográficas independientes.
function hasBookSignal(item) {
  const domain = clean(item?.domain_id).toUpperCase();
  const hasIsbn = Boolean(normalizeValidIsbn(item?.isbn));
  const supportingSignals = [
    !isGenericAuthor(item?.author),
    Boolean(positiveInteger(item?.pages)),
    fieldCount(item?.bibliographic) > 0,
  ].filter(Boolean).length;

  if (/(?:^|[-_])BOOKS(?:$|[-_])/.test(domain)) return true;
  if (domain) return hasIsbn && supportingSignals >= 1;
  return hasIsbn || supportingSignals >= 2;
}

export function isShowcaseEligible(item) {
  return /^MLU\d+$/.test(clean(item?.id).toUpperCase()) &&
    clean(item?.title).length >= 2 &&
    item?.status === 'active' &&
    Number(item?.available_quantity) > 0 &&
    Number(item?.price) > 0 &&
    validCurrency(item) &&
    hasBookSignal(item);
}

export function showcaseEditionKey(item) {
  const condition = normalizedText(item?.condition) || 'unknown';
  const isbn = normalizeValidIsbn(item?.isbn);
  if (isbn) return `isbn:${isbn}:${condition}`;

  return [
    'work',
    normalizedText(item?.title),
    normalizedText(item?.author),
    condition,
  ].join(':');
}

function prioritySet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value.map(id => clean(id).toUpperCase()) : []);
}

export function scoreShowcaseItem(item, { priorityIds = [] } = {}) {
  if (!isShowcaseEligible(item)) return Number.NEGATIVE_INFINITY;

  const priorities = prioritySet(priorityIds);
  const description = descriptionLength(item);
  const images = pictureCount(item);
  const bibliography = fieldCount(item?.bibliographic);
  const dimensions = fieldCount(item?.dimensions);
  const stock = Math.max(0, Number(item?.available_quantity) || 0);
  const title = clean(item?.title);
  let score = 0;

  if (priorities.has(clean(item.id).toUpperCase())) score += 2200;

  if (description >= 80) score += 260;
  if (description >= 280) score += 180;
  if (description >= 700) score += 100;
  if (description >= 1400) score += 60;

  if (normalizeValidIsbn(item?.isbn)) score += 220;
  if (!isGenericAuthor(item?.author)) score += 190;
  if (realPublisher(item?.publisher)) score += 140;
  if (positiveInteger(item?.pages)) score += 110;

  score += Math.min(210, bibliography * 35);
  score += Math.min(70, dimensions * 18);

  if (images >= 1) score += 100;
  if (images >= 2) score += 80;
  if (images >= 4) score += 70;

  if (clean(item?.catalog_product_id)) score += 70;
  if (item?.catalog_listing === true) score += 45;
  if (normalizedText(item?.condition) === 'new') score += 40;
  score += Math.min(100, Math.round(Math.log2(stock + 1) * 25));

  if (title.length >= 8 && title.length <= 150) score += 30;
  if (/Ã|Â|â|�/.test(title)) score -= 250;

  return score;
}

function candidateFor(item, priorityIds) {
  return {
    item,
    id: clean(item.id).toUpperCase(),
    score: scoreShowcaseItem(item, { priorityIds }),
    stock: Math.max(0, Number(item.available_quantity) || 0),
    description: descriptionLength(item),
    pictures: pictureCount(item),
    startedAt: validDate(item.start_time),
  };
}

function compareCandidates(a, b) {
  return b.score - a.score ||
    b.stock - a.stock ||
    b.description - a.description ||
    b.pictures - a.pictures ||
    b.startedAt - a.startedAt ||
    a.id.localeCompare(b.id);
}

export function rankShowcaseItems(items = [], {
  limit = DEFAULT_SHOWCASE_LIMIT,
  priorityIds = [],
} = {}) {
  const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
  const priorities = prioritySet(priorityIds);
  const bestByEdition = new Map();
  let eligibleItems = 0;

  for (const item of items) {
    if (!isShowcaseEligible(item)) continue;
    eligibleItems++;
    const candidate = candidateFor(item, priorities);
    const key = showcaseEditionKey(item);
    const current = bestByEdition.get(key);
    if (!current || compareCandidates(candidate, current) < 0) {
      bestByEdition.set(key, candidate);
    }
  }

  const selected = [...bestByEdition.values()]
    .sort(compareCandidates)
    .slice(0, safeLimit)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
      contentLevel: candidate.description >= 280
        ? 'editorial'
        : candidate.description >= 80
          ? 'descriptive'
          : 'bibliographic',
    }));

  return {
    eligibleItems,
    uniqueEditions: bestByEdition.size,
    duplicateEditionsExcluded: Math.max(0, eligibleItems - bestByEdition.size),
    selected,
  };
}

export function assignShowcaseRanking(items = [], options = {}) {
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    delete item.showcase_rank;
    delete item.showcase_score;
    delete item.showcase_content_level;
  }

  const ranked = rankShowcaseItems(items, options);
  for (const candidate of ranked.selected) {
    candidate.item.showcase_rank = candidate.rank;
    candidate.item.showcase_score = candidate.score;
    candidate.item.showcase_content_level = candidate.contentLevel;
  }

  const selectedWithDescription = ranked.selected
    .filter(candidate => candidate.description >= 80).length;
  const selectedWithIsbn = ranked.selected
    .filter(candidate => Boolean(normalizeValidIsbn(candidate.item.isbn))).length;
  const selectedWithMultipleImages = ranked.selected
    .filter(candidate => candidate.pictures >= 2).length;

  return {
    schema_version: 1,
    limit: Math.max(0, Math.floor(Number(options.limit ?? DEFAULT_SHOWCASE_LIMIT) || 0)),
    eligible_items: ranked.eligibleItems,
    unique_editions: ranked.uniqueEditions,
    duplicate_editions_excluded: ranked.duplicateEditionsExcluded,
    selected_items: ranked.selected.length,
    selected_with_description: selectedWithDescription,
    selected_with_isbn: selectedWithIsbn,
    selected_with_multiple_images: selectedWithMultipleImages,
    highest_score: ranked.selected[0]?.score ?? null,
    lowest_score: ranked.selected.at(-1)?.score ?? null,
  };
}
