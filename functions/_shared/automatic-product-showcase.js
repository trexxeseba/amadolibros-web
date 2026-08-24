// FICHAS-VIDRIERA-1000: transforma datos reales del catálogo en una ficha
// visible y útil. No inventa sinopsis, biografías, reseñas ni calificaciones.

import { isGenericAuthor, normalizeValidIsbn } from './showcase-ranking.js';

const JSON_LD_RE = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
const DETAIL_ROW_RE = /<div class="detail-row"><dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g;
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

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_full, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_full, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

function realPublisher(value) {
  const publisher = clean(value);
  if (!publisher || PLACEHOLDER_PUBLISHERS.has(normalizedText(publisher))) return null;
  return publisher;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function titleWithoutDuplicateSubtitle(title, subtitle) {
  const value = clean(subtitle);
  if (!value) return null;
  const titleKey = normalizedText(title);
  const subtitleKey = normalizedText(value);
  if (!subtitleKey || titleKey.includes(subtitleKey) || subtitleKey.includes(titleKey)) return null;
  return value;
}

function sentenceGroups(text, maxChars = 650, maxParagraphs = 4) {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  if (!normalized) return [];

  const existingParagraphs = normalized
    .split(/\n{2,}/)
    .map(paragraph => clean(paragraph))
    .filter(Boolean);
  const units = existingParagraphs.length > 1
    ? existingParagraphs
    : normalized.split(/(?<=[.!?])\s+/u).map(clean).filter(Boolean);

  const paragraphs = [];
  let current = '';
  for (const unit of units) {
    if (paragraphs.length >= maxParagraphs) break;
    if (!current) {
      current = unit;
      continue;
    }
    if (`${current} ${unit}`.length <= maxChars) {
      current = `${current} ${unit}`;
      continue;
    }
    paragraphs.push(current);
    current = unit;
  }
  if (current && paragraphs.length < maxParagraphs) paragraphs.push(current);

  return paragraphs.map(paragraph => paragraph.length <= maxChars
    ? paragraph
    : `${paragraph.slice(0, maxChars).replace(/\s+\S*$/u, '')}…`);
}

function formatDimensions(dimensions) {
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) return null;
  const values = [
    dimensions.height ? `alto ${clean(dimensions.height)}` : null,
    dimensions.width ? `ancho ${clean(dimensions.width)}` : null,
    dimensions.length ? `lomo/largo ${clean(dimensions.length)}` : null,
    dimensions.weight ? `peso ${clean(dimensions.weight)}` : null,
  ].filter(Boolean);
  return values.length ? values.join(' · ') : null;
}

function formatCondition(value) {
  const condition = normalizedText(value);
  if (condition === 'new' || condition.endsWith('/newcondition')) return 'Nuevo';
  if (condition === 'used' || condition.endsWith('/usedcondition')) return 'Usado';
  if (condition === 'not_specified') return 'No especificada';
  return clean(value) || null;
}

function buildEditionFacts(item) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const facts = [
    ['Autoría', !isGenericAuthor(item?.author) ? clean(item.author) : null],
    ['Subtítulo', titleWithoutDuplicateSubtitle(item?.title, bibliography.subtitle)],
    ['Editorial', realPublisher(item?.publisher)],
    ['Colección', clean(bibliography.collection) || null],
    ['ISBN', normalizeValidIsbn(item?.isbn) || clean(item?.isbn) || null],
    ['Edición', clean(bibliography.edition) || null],
    ['Año de publicación', clean(bibliography.publication_year) || null],
    ['Páginas', positiveInteger(item?.pages)],
    ['Formato', clean(bibliography.format) || null],
    ['Idioma', clean(bibliography.language) || null],
    ['Género/temática', clean(bibliography.genre) || null],
    ['Temas', Array.isArray(bibliography.subjects)
      ? bibliography.subjects.map(clean).filter(Boolean).join(' · ')
      : null],
    ['Traducción', clean(bibliography.translator) || null],
    ['Ilustración', clean(bibliography.illustrator) || null],
    ['Medidas', formatDimensions(item?.dimensions) || clean(item?.dimensions_text) || null],
    ['Condición', formatCondition(item?.condition)],
  ];

  return facts
    .filter(([, value]) => value !== null && value !== undefined && clean(value))
    .map(([label, value]) => ({ label, value: String(value) }));
}

function buildFactualSummary(item, facts) {
  const title = clean(item.title);
  const author = !isGenericAuthor(item.author) ? clean(item.author) : null;
  const isbn = normalizeValidIsbn(item.isbn);
  const publisher = realPublisher(item.publisher);
  const pages = positiveInteger(item.pages);
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const format = clean(bibliography.format) || null;
  const language = clean(bibliography.language) || null;
  const year = clean(bibliography.publication_year) || null;
  const subjects = Array.isArray(bibliography.subjects)
    ? bibliography.subjects.map(clean).filter(Boolean).slice(0, 6)
    : [];

  const identity = `«${title}»${author ? `, de ${author},` : ''}${publisher ? ` es una edición publicada por ${publisher}` : ' corresponde a esta edición disponible'}${year ? ` en ${year}` : ''}.`;
  const edition = [
    pages ? `${pages} páginas` : null,
    format,
    language ? `en ${language}` : null,
  ].filter(Boolean);
  const details = edition.length
    ? `La edición tiene ${edition.join(', ')}.`
    : null;
  const identifier = isbn
    ? `El ISBN ${isbn} identifica esta versión concreta para compararla con otras presentaciones.`
    : null;

  const topics = subjects.length
    ? `Los temas bibliográficos registrados incluyen ${subjects.join(', ')}.`
    : null;

  return [identity, details, topics, identifier].filter(Boolean);
}

function buildHighlights(item, facts) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const images = new Set([
    ...(Array.isArray(item?.pictures) ? item.pictures : []),
    item?.thumbnail,
  ].filter(Boolean)).size;
  const highlights = [
    clean(bibliography.genre) ? `Género o temática registrada: ${clean(bibliography.genre)}.` : null,
    Array.isArray(bibliography.subjects) && bibliography.subjects.length
      ? `Temas bibliográficos: ${bibliography.subjects.map(clean).filter(Boolean).slice(0, 6).join(', ')}.`
      : null,
    clean(bibliography.format) ? `Formato: ${clean(bibliography.format)}.` : null,
    clean(bibliography.edition) ? `Edición: ${clean(bibliography.edition)}.` : null,
    positiveInteger(item?.pages) ? `${positiveInteger(item.pages)} páginas.` : null,
    clean(bibliography.language) ? `Idioma: ${clean(bibliography.language)}.` : null,
    clean(bibliography.collection) ? `Colección: ${clean(bibliography.collection)}.` : null,
    normalizeValidIsbn(item?.isbn) ? `Edición identificada con ISBN ${normalizeValidIsbn(item.isbn)}.` : null,
    images >= 2 ? `La publicación incluye ${images} imágenes para revisar portada y edición.` : null,
    realPublisher(item?.publisher) ? `Editorial: ${realPublisher(item.publisher)}.` : null,
  ].filter(Boolean);

  for (const fact of facts) {
    if (highlights.length >= 5) break;
    const candidate = `${fact.label}: ${fact.value}.`;
    if (!highlights.some(value => normalizedText(value) === normalizedText(candidate))) {
      highlights.push(candidate);
    }
  }
  // FICHAS-QUALITY-GUARD-1: antes se rellenaba hasta un mínimo de 3 con frases
  // genéricas ("Disponible para compra inmediata…") que no son datos de la
  // edición. Ese relleno se elimina: se devuelve sólo lo que la publicación
  // realmente aporta, aunque sean menos de tres puntos o ninguno. Una lista
  // vacía hace que la sección entera se omita.
  return highlights.slice(0, 5);
}

// FICHAS-QUALITY-GUARD-1: el bloque de audiencia sólo puede construirse
// recombinando autor y categoría — no aporta ningún hecho verificable sobre la
// edición. Devolver null hace que la sección se omita por completo en la ficha
// automática. Las fichas curadas a mano (functions/_shared/product-showcases.js)
// siguen pudiendo declarar su propio `audience` real, que sí se renderiza.
function audienceCopy() {
  return null;
}

// FICHAS-QUALITY-GUARD-1: sin autoría verificable no hay nada honesto que
// contar sobre el autor. Antes se emitía una sección con el nombre repetido
// ("Más sobre Desconocido") o un párrafo de disculpa; ambas ocupaban espacio
// comercial sin informar. Ahora la sección simplemente no existe.
function authorCopy(item) {
  const author = !isGenericAuthor(item?.author) ? clean(item.author) : null;
  if (!author) return null;
  return {
    heading: `Más sobre ${author}`,
    copy: `La autoría de esta publicación figura como ${author}. Desde esta ficha podés consultar otros títulos disponibles de la misma autoría y comparar ediciones en el catálogo de Amado Libros.`,
  };
}

function contextualRequestHelp(item, classificationTags = []) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const genre = normalizedText(bibliography.genre);
  const tags = new Set(classificationTags.map(normalizedText).filter(Boolean));
  const query = new URLSearchParams({
    tipo: 'exacto',
    q: clean(item?.title),
    origen: 'ficha',
  });
  if (clean(item?.id)) query.set('libro', clean(item.id));

  let question = '¿Buscás otro libro o una edición específica?';
  if (tags.has('biblia') || tags.has('reina-valera') ||
      /\bbiblias?\b/u.test(genre) || /\breina[\s-]+valera\b/u.test(genre)) {
    question = '¿Buscás otra Biblia o una edición específica?';
  } else if (tags.has('esoterismo-tarot') ||
             /\b(tarot|oracul\w*|esoter\w*)\b/u.test(genre)) {
    question = '¿Buscás otro tarot, oráculo o libro de esoterismo?';
  }

  return {
    question,
    href: `/pedir-libro?${query.toString()}`,
    label: 'Contanos qué buscás',
  };
}

function buildLinks(item) {
  const links = [];
  const author = !isGenericAuthor(item?.author) ? clean(item.author) : null;
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const genre = clean(bibliography.genre);
  if (author) {
    links.push({
      href: `/catalogo?q=${encodeURIComponent(author)}`,
      label: `Ver otros libros de ${author}`,
    });
  }
  if (genre) {
    links.push({
      href: `/catalogo?q=${encodeURIComponent(genre)}`,
      label: `Explorar libros de ${genre}`,
    });
  }
  if (links.length === 0) {
    links.push({
      href: '/catalogo',
      label: 'Seguir explorando el catálogo',
    });
  }
  return links.slice(0, 2);
}

function shortenByWord(value, maxLength) {
  const text = clean(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).replace(/\s+\S*$/u, '')}…`;
}

function buildMetaDescription(item) {
  const title = clean(item.title);
  const author = !isGenericAuthor(item.author) ? clean(item.author) : null;
  const isbn = normalizeValidIsbn(item.isbn);
  const identity = `Comprá ${title}${author ? ` de ${author}` : ''} en Uruguay.`;
  const edition = isbn ? ` ISBN ${isbn}.` : '';
  return shortenByWord(
    `${identity}${edition} Consultá stock, 12% menos por transferencia, cuotas y envíos a todo el país.`,
    170,
  );
}

function schemaTypes(schema) {
  const raw = schema?.['@type'];
  return Array.isArray(raw) ? raw : [raw].filter(Boolean);
}

function personName(value) {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(personName).filter(Boolean).join(', ');
  return clean(value?.name);
}

function organizationName(value) {
  if (typeof value === 'string') return clean(value);
  return clean(value?.name);
}

function detailMapFromHtml(html) {
  const details = new Map();
  for (const match of String(html || '').matchAll(DETAIL_ROW_RE)) {
    details.set(normalizedText(decodeHtml(match[1])), decodeHtml(match[2]));
  }
  return details;
}

function detail(details, ...labels) {
  for (const label of labels) {
    const value = details.get(normalizedText(label));
    if (value) return value;
  }
  return null;
}

function productSchemaFromHtml(html, productId) {
  for (const match of String(html || '').matchAll(JSON_LD_RE)) {
    try {
      const schema = JSON.parse(match[1]);
      if (schemaTypes(schema).includes('Book') && String(schema.sku || '').toUpperCase() === productId) {
        return schema;
      }
    } catch {
      // Otro bloque JSON-LD inválido no debe impedir leer la ficha.
    }
  }
  return null;
}

function usableDescription(description, title, author) {
  const value = clean(description);
  if (!value) return null;
  const key = normalizedText(value);
  const generic = [
    normalizedText(title),
    normalizedText(author ? `${title} — ${author}` : title),
    normalizedText(author ? `${title} - ${author}` : title),
  ];
  return generic.includes(key) ? null : value;
}

export function productItemFromProductHtml(html, productId) {
  const id = String(productId || '').toUpperCase();
  const schema = productSchemaFromHtml(html, id);
  if (!schema) return null;

  const details = detailMapFromHtml(html);
  const title = clean(schema.name) || decodeHtml(String(html || '').match(/<h1>([\s\S]*?)<\/h1>/)?.[1]);
  if (!title) return null;
  const author = personName(schema.author) || detail(details, 'Autor', 'Autoría');
  const images = Array.isArray(schema.image)
    ? schema.image.filter(Boolean)
    : [schema.image].filter(Boolean);
  const offer = Array.isArray(schema.offers) ? schema.offers[0] : schema.offers;
  const publisher = organizationName(schema.publisher) || detail(details, 'Editorial');
  const pages = positiveInteger(schema.numberOfPages) || positiveInteger(detail(details, 'Páginas'));
  const description = usableDescription(schema.description, title, author);

  return {
    id,
    title,
    author: author || null,
    isbn: clean(schema.isbn) || detail(details, 'ISBN'),
    publisher: publisher || null,
    pages,
    description,
    pictures: images,
    condition: detail(details, 'Condición') || offer?.itemCondition || null,
    dimensions_text: detail(details, 'Medidas'),
    bibliographic: {
      subtitle: detail(details, 'Subtítulo'),
      language: detail(details, 'Idioma') || clean(schema.inLanguage) || null,
      format: detail(details, 'Formato') || clean(schema.bookFormat) || null,
      edition: detail(details, 'Edición') || clean(schema.bookEdition) || null,
      publication_year: detail(details, 'Año') || clean(schema.datePublished) || null,
      genre: detail(details, 'Género', 'Género/temática') || clean(schema.genre) || null,
      subjects: detail(details, 'Temas')
        ? detail(details, 'Temas').split('·').map(clean).filter(Boolean).slice(0, 6)
        : Array.isArray(schema.keywords) ? schema.keywords.map(clean).filter(Boolean).slice(0, 6) : [],
      collection: detail(details, 'Colección'),
      translator: detail(details, 'Traductor/a', 'Traducción') || personName(schema.translator) || null,
      illustrator: detail(details, 'Ilustrador/a', 'Ilustración') || personName(schema.illustrator) || null,
    },
  };
}

export function buildAutomaticProductShowcase(item, {
  classificationTags = [],
  enrichment = null,
} = {}) {
  if (!item || typeof item !== 'object' || !clean(item.title)) return null;
  const facts = buildEditionFacts(item);
  const description = clean(item.description);
  const descriptionParagraphs = description.length >= 80
    ? sentenceGroups(item.description)
    : [];
  const summary = descriptionParagraphs.length
    ? descriptionParagraphs
    : buildFactualSummary(item, facts);
  const author = authorCopy(item);
  const bibliography = item.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const subtitle = titleWithoutDuplicateSubtitle(item.title, bibliography.subtitle) ||
    (!isGenericAuthor(item.author) ? `De ${clean(item.author)}` : null);
  const schemaDescription = shortenByWord(summary.join(' '), 500);

  const editorial = enrichment?.editorial || null;
  const verifiedSchema = enrichment?.schema || null;

  return {
    h1: clean(item.title),
    subtitle,
    eyebrow: editorial?.eyebrow || (descriptionParagraphs.length
      ? (clean(bibliography.genre) || 'Descripción y datos de la edición')
      : 'Ficha ampliada de esta edición'),
    introHeading: editorial?.heading || (descriptionParagraphs.length
      ? `¿De qué trata ${clean(item.title)}?`
      : `Sobre ${clean(item.title)}`),
    summary: editorial?.paragraphs || summary,
    highlightsHeading: editorial?.highlights_heading || 'Datos destacados',
    // FICHAS-QUALITY-GUARD-1: sin datos reales de la edición, `highlights`
    // queda vacío y el render omite la tarjeta en vez de rellenarla.
    highlights: editorial?.highlights || buildHighlights(item, facts),
    audienceHeading: editorial?.decision_heading || '¿Para quién puede ser útil?',
    audience: editorial?.decision_copy || audienceCopy(item),
    // FICHAS-QUALITY-GUARD-1: `author` es null cuando la autoría es genérica o
    // ausente; en ese caso no se emite encabezado ni copy y la tarjeta “Sobre
    // la autoría” desaparece por completo.
    authorHeading: author?.heading ?? null,
    authorBio: author?.copy ?? null,
    editionHeading: 'Ficha de esta edición',
    verifiedLabel: normalizeValidIsbn(item.isbn)
      ? 'Edición identificada por ISBN'
      : 'Datos tomados de la publicación',
    editionFacts: facts,
    links: editorial?.links || buildLinks(item),
    requestHelp: contextualRequestHelp(item, classificationTags),
    sources: enrichment?.provenance || [],
    schemaDescription: editorial?.paragraphs?.join(' ') || schemaDescription,
    schemaVerified: verifiedSchema,
    metaDescription: editorial?.meta_description || buildMetaDescription(item),
  };
}
