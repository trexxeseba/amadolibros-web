// FICHAS-VIDRIERA-3000-QUALITY: título visible derivado de forma conservadora.
// Nunca modifica el título fuente, el slug ni el canonical. Sólo retira sufijos
// comerciales que pueden identificarse como autor/editorial/formato/idioma/año.

const LOWERCASE_WORDS = new Set([
  'a', 'al', 'con', 'contra', 'de', 'del', 'desde', 'durante', 'e', 'el', 'en',
  'entre', 'hacia', 'hasta', 'la', 'las', 'los', 'o', 'para', 'por', 'según',
  'sin', 'sobre', 'tras', 'u', 'un', 'una', 'unas', 'unos', 'y',
]);

const ACRONYMS = new Map([
  ['adn', 'ADN'],
  ['a4', 'A4'],
  ['b1', 'B1'],
  ['cie', 'CIE'],
  ['dsm', 'DSM'],
  ['emdr', 'EMDR'],
  ['isbn', 'ISBN'],
  ['nvi', 'NVI'],
  ['ntv', 'NTV'],
  ['rvr', 'RVR'],
  ['tcc', 'TCC'],
  ['tdah', 'TDAH'],
  ['toc', 'TOC'],
  ['ux', 'UX'],
]);

const GENERIC_AUTHOR_LABELS = new Set([
  'anonimo', 'anónimo', 'autor', 'autores', 'varios', 'varios autores',
  'vv aa', 'vv. aa.', 'vv aa.', 'vv. aa', 'sin autor', 's a', 's/a',
]);

const NAME_CONNECTORS = new Set(['de', 'del', 'la', 'las', 'los', 'y']);
const METADATA_PREFIX_RE = /^(?:de\s+|autor(?:a|es)?\s*:?|editorial\b|editado\s+por\b|tapa\s+(?:blanda|dura)\b|encuadernaci[oó]n\b|formato\b|idioma\b|en\s+(?:espa[nñ]ol|ingl[eé]s|portugu[eé]s|franc[eé]s|italiano|alem[aá]n)\b|colecci[oó]n\b|serie\b|biblioteca\b|(?:1[89]|20)\d{2}$|\d+[.ªºa]?\s*edici[oó]n\b)/iu;
const COLLECTION_SUFFIX_RE = /^\d{1,4}\s+(?:biblioteca|colecci[oó]n|serie)\b/iu;
const PAREN_METADATA_RE = /\s*\(([^()]*)\)\s*$/u;

function clean(value) {
  return String(value ?? '')
    .replace(/[\u00a0\s]+/gu, ' ')
    .replace(/\s+([,.;:!?])/gu, '$1')
    .replace(/([,;:]){2,}/gu, '$1')
    .replace(/\.{2,}$/u, '.')
    .trim();
}

function normalizedText(value) {
  return clean(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es')
    .replace(/[“”"'`´]/gu, '')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

function bibliography(item) {
  return item?.bibliographic && typeof item.bibliographic === 'object' && !Array.isArray(item.bibliographic)
    ? item.bibliographic
    : {};
}

function authorKeys(value) {
  const source = clean(value);
  if (!source) return new Set();
  const parts = [
    source,
    ...source.split(/\s*(?:,|\by\b|&|\/|;)\s*/iu),
  ].map(normalizedText).filter(Boolean);
  return new Set(parts);
}

function exactMetadataKeys(item) {
  const book = bibliography(item);
  const values = [
    item?.publisher,
    book.format,
    book.language,
    book.edition,
    book.publication_year,
    book.collection,
  ].map(normalizedText).filter(Boolean);
  return new Set(values);
}

function stripLabel(value) {
  return normalizedText(value)
    .replace(/^(?:editorial|editado por|formato|idioma|coleccion|serie|biblioteca|edicion)\s+/u, '')
    .trim();
}

function looksLikePersonName(value) {
  const source = clean(value).replace(/^de\s+/iu, '').trim();
  const words = source.split(/\s+/u).filter(Boolean);
  const significant = words.filter(word => !NAME_CONNECTORS.has(normalizedText(word)));
  if (significant.length < 2 || significant.length > 7) return false;
  return significant.every(word =>
    /^[\p{Lu}][\p{L}.'’\-]*$/u.test(word) || /^[\p{Lu}]\.$/u.test(word));
}

function isAuthorMetadata(segment, item) {
  const key = normalizedText(segment);
  if (!key) return false;
  const authors = authorKeys(item?.author);
  const withoutLabel = key.replace(/^(?:de|autor|autora|autores)\s+/u, '').trim();
  if (GENERIC_AUTHOR_LABELS.has(key) || GENERIC_AUTHOR_LABELS.has(withoutLabel)) return true;
  if (authors.has(key) || authors.has(withoutLabel)) return true;

  // Sólo se acepta un "de Nombre Apellido" no exacto cuando aparece como
  // segmento separado y sus palabras tienen aspecto inequívoco de nombre.
  return /^de\s+/iu.test(clean(segment)) && looksLikePersonName(segment);
}

function isMetadataSegment(segment, item) {
  const value = clean(segment).replace(/[.;]+$/u, '').trim();
  const key = normalizedText(value);
  if (!key) return false;
  if (isAuthorMetadata(value, item)) return true;

  const exact = exactMetadataKeys(item);
  if (exact.has(key) || exact.has(stripLabel(key))) return true;
  if (METADATA_PREFIX_RE.test(value)) return true;

  const book = bibliography(item);
  const year = normalizedText(book.publication_year);
  if (year && new RegExp(`(?:^|\\s)${year}(?:$|\\s)`, 'u').test(key)) return true;

  const publisher = normalizedText(item?.publisher);
  if (publisher && key.startsWith('editorial ') && key.includes(publisher)) return true;

  return false;
}

function prepareSeparators(title) {
  return clean(title)
    .replace(/,\s+(?=(?:de\s+|autor(?:a|es)?\s*:?|editorial\b|tapa\b|formato\b|idioma\b|en\s+(?:espa[nñ]ol|ingl[eé]s|portugu[eé]s|franc[eé]s|italiano|alem[aá]n)\b|colecci[oó]n\b|serie\b|biblioteca\b|(?:1[89]|20)\d{2}\b|\d+[.ªºa]?\s*edici[oó]n\b))/giu, ' | ')
    .replace(/\.\s+(?=(?:editorial\b|tapa\b|formato\b|idioma\b|en\s+(?:espa[nñ]ol|ingl[eé]s|portugu[eé]s|franc[eé]s|italiano|alem[aá]n)\b|colecci[oó]n\b|serie\b|biblioteca\b|(?:1[89]|20)\d{2}\b))/giu, ' | ')
    .replace(/\s+[–—-]\s+(?=(?:de\s+|editorial\b|tapa\b|formato\b|idioma\b|en\s+(?:espa[nñ]ol|ingl[eé]s|portugu[eé]s|franc[eé]s|italiano|alem[aá]n)\b|(?:1[89]|20)\d{2}\b))/giu, ' | ');
}

function normalizeWordCase(title) {
  const pieces = clean(title).split(/(\s+|[-–—/:])/u);
  let wordIndex = 0;
  return pieces.map(piece => {
    if (!piece || /^(?:\s+|[-–—/:])$/u.test(piece)) return piece;
    const key = normalizedText(piece);
    const acronym = ACRONYMS.get(key);
    if (acronym) {
      wordIndex++;
      return acronym;
    }
    const output = wordIndex > 0 && LOWERCASE_WORDS.has(key)
      ? piece.toLocaleLowerCase('es')
      : piece;
    wordIndex++;
    return output;
  }).join('');
}

function safeCandidate(rawTitle, candidate) {
  const raw = clean(rawTitle);
  const value = clean(candidate).replace(/[|,;:.-]+$/u, '').trim();
  if (value.length < 4) return raw;
  if (value.length < Math.min(12, Math.ceil(raw.length * 0.22))) return raw;
  return value;
}

export function deriveBookDisplayTitle(item = {}) {
  const rawTitle = clean(item?.title);
  if (!rawTitle) {
    return Object.freeze({
      rawTitle: '',
      title: '',
      changed: false,
      removedParts: Object.freeze([]),
      reason: 'empty',
    });
  }

  const removedParts = [];
  let candidate = rawTitle;

  // Sufijos parentéticos puramente comerciales: “(tapa blanda, español, 2020)”.
  const parenthetical = candidate.match(PAREN_METADATA_RE);
  if (parenthetical && isMetadataSegment(parenthetical[1], item)) {
    removedParts.unshift(clean(parenthetical[1]));
    candidate = candidate.slice(0, parenthetical.index).trim();
  }

  const segments = prepareSeparators(candidate)
    .split(/\s*\|\s*/u)
    .map(clean)
    .filter(Boolean);
  while (segments.length > 1 && isMetadataSegment(segments.at(-1), item)) {
    removedParts.unshift(segments.pop());
  }
  candidate = segments.join(' | ');

  // Colección/número trasladado al bloque bibliográfico, nunca se elimina un
  // subtítulo normal luego de dos puntos.
  const colonIndex = candidate.lastIndexOf(':');
  if (colonIndex > 3) {
    const suffix = clean(candidate.slice(colonIndex + 1));
    const collection = normalizedText(bibliography(item).collection);
    const suffixKey = normalizedText(suffix);
    if (COLLECTION_SUFFIX_RE.test(suffix) || (collection && suffixKey === collection)) {
      removedParts.unshift(suffix);
      candidate = candidate.slice(0, colonIndex);
    }
  }

  const candidateBeforeSafety = clean(candidate);
  const safe = safeCandidate(rawTitle, candidateBeforeSafety);
  const rejectedRemoval = removedParts.length > 0 && safe === rawTitle && candidateBeforeSafety !== rawTitle;
  const effectiveRemovedParts = rejectedRemoval ? [] : removedParts;
  const displayTitle = rejectedRemoval ? rawTitle : normalizeWordCase(safe);
  const changed = displayTitle !== rawTitle;

  return Object.freeze({
    rawTitle,
    title: displayTitle,
    changed,
    removedParts: Object.freeze(effectiveRemovedParts),
    reason: effectiveRemovedParts.length
      ? 'metadata-suffix'
      : changed
        ? 'case-normalization'
        : 'unchanged',
  });
}

function shortenByWord(value, maxLength) {
  const text = clean(value);
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, Math.max(1, maxLength - 1)).replace(/\s+\S*$/u, '').trim();
  return `${sliced || text.slice(0, maxLength - 1)}…`;
}

export function buildBookSeoTitle(displayTitle, {
  brand = 'Amado Libros',
  maxLength = 70,
} = {}) {
  const title = clean(displayTitle);
  if (!title) return brand;
  const separator = ' | ';
  const available = Math.max(20, maxLength - brand.length - separator.length);
  return `${shortenByWord(title, available)}${separator}${brand}`;
}
