// FICHAS-VIDRIERA-1000: transforma datos reales del catálogo en una ficha
// visible y útil. No inventa sinopsis, biografías, reseñas ni calificaciones.

import { isGenericAuthor, normalizeValidIsbn } from './showcase-ranking.js';

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
  if (condition === 'new') return 'Nuevo';
  if (condition === 'used') return 'Usado';
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
    ['Traducción', clean(bibliography.translator) || null],
    ['Ilustración', clean(bibliography.illustrator) || null],
    ['Medidas', formatDimensions(item?.dimensions)],
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

  const identity = `Esta ficha corresponde a «${title}»${author ? `, de ${author}` : ''}.`;
  const edition = [
    isbn ? `ISBN ${isbn}` : null,
    publisher ? `editorial ${publisher}` : null,
    pages ? `${pages} páginas` : null,
    format,
  ].filter(Boolean);
  const detail = edition.length
    ? `La publicación aporta estos datos de edición: ${edition.join(', ')}.`
    : 'La publicación no aporta todavía una ficha bibliográfica completa; por eso no agregamos datos que no estén confirmados.';
  const verification = facts.length >= 5
    ? 'Podés revisar debajo los datos disponibles de esta edición antes de comprar y compararlos con el ejemplar que buscás.'
    : 'Antes de comprar, consultanos cualquier dato de edición que necesites confirmar.';

  return [identity, `${detail} ${verification}`];
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
  if (highlights.length < 3) {
    highlights.push('Disponible para compra inmediata en Amado Libros.');
  }
  return highlights.slice(0, 5);
}

function audienceCopy(item) {
  const bibliography = item?.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};
  const genre = clean(bibliography.genre);
  const author = !isGenericAuthor(item?.author) ? clean(item.author) : null;
  if (genre && author) {
    return `Puede interesar a lectores de ${author} y a quienes buscan obras registradas dentro de ${genre}. La ficha permite verificar la edición concreta antes de comprar.`;
  }
  if (genre) {
    return `Puede interesar a quienes buscan lecturas de ${genre}. La ficha reúne los datos disponibles para comprobar que se trata de la edición correcta.`;
  }
  if (author) {
    return `Pensado para lectores de ${author} y para quienes buscan esta obra o una edición específica. Revisá ISBN, editorial y formato antes de confirmar la compra.`;
  }
  return 'Para quienes buscan esta obra y necesitan comprobar edición, ISBN, editorial, formato o condición antes de comprar.';
}

function authorCopy(item) {
  const author = !isGenericAuthor(item?.author) ? clean(item.author) : null;
  if (author) {
    return {
      heading: `Más sobre ${author}`,
      copy: `La autoría de esta publicación figura como ${author}. Desde esta ficha podés consultar otros títulos disponibles de la misma autoría y comparar ediciones en el catálogo de Amado Libros.`,
    };
  }
  return {
    heading: 'Sobre la autoría',
    copy: 'La publicación no aporta una autoría suficientemente clara. No completamos ese dato por inferencia: podés consultarnos para verificarlo antes de comprar.',
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
  if (normalizeValidIsbn(item?.isbn)) {
    links.push({
      href: '/como-identificar-edicion-correcta-isbn',
      label: 'Cómo verificar una edición por ISBN',
    });
  }
  if (links.length === 0) {
    links.push({ href: '/catalogo', label: 'Seguir explorando el catálogo' });
  }
  return links.slice(0, 3);
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

export function buildAutomaticProductShowcase(item) {
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

  return {
    h1: clean(item.title),
    subtitle,
    eyebrow: descriptionParagraphs.length
      ? (clean(bibliography.genre) || 'Descripción y datos de la edición')
      : 'Ficha ampliada de esta edición',
    introHeading: descriptionParagraphs.length
      ? `¿De qué trata ${clean(item.title)}?`
      : `Sobre ${clean(item.title)}`,
    summary,
    highlightsHeading: 'Datos destacados',
    highlights: buildHighlights(item, facts),
    audienceHeading: '¿Para quién puede ser útil?',
    audience: audienceCopy(item),
    authorHeading: author.heading,
    authorBio: author.copy,
    editionHeading: 'Ficha de esta edición',
    verifiedLabel: normalizeValidIsbn(item.isbn)
      ? 'Edición identificada por ISBN'
      : 'Datos tomados de la publicación',
    editionFacts: facts,
    links: buildLinks(item),
    schemaDescription,
    metaDescription: buildMetaDescription(item),
  };
}
