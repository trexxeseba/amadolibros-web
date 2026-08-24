// FICHAS-ENRICHMENT-BIBLIAS-1
//
// Registro editorial por EDICIÓN (ISBN-13), nunca por publicación MLU.
// Una investigación se reutiliza en todos los duplicados compatibles, pero
// sólo puede aportar datos bibliográficos y copy editorial: precio, stock,
// condición, imágenes, título comercial, id y URL permanecen en el catálogo.

import { normalizeValidIsbn } from './showcase-ranking.js';

const SOURCE_TYPES = new Set([
  'publisher',
  'national_library',
  'library_catalog',
  'commercial_reference',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

const BIBLE_ENRICHMENTS = Object.freeze([
  Object.freeze({
    schema_version: 1,
    isbn: '9788490739808',
    decision: 'auto_publish',
    verified_at: '2026-08-24',
    editorial: Object.freeze({
      eyebrow: 'Biblia en español · edición verificada',
      heading: 'Qué contiene esta edición de La Biblia Palabra de Vida',
      paragraphs: Object.freeze([
        'Esta es la edición Hispanoamérica de La Biblia Palabra de Vida, publicada por Editorial Verbo Divino. Corresponde al ISBN 9788490739808, segunda edición —reimpresión 2—, en formato rústico cosido de 15 × 21 cm y 1.600 páginas.',
        'Utiliza una traducción interconfesional realizada desde las lenguas originales hebrea, aramea y griega. Incluye introducciones a cada libro, mapas a color, ilustraciones y apéndices con vocabulario bíblico, lecturas, preguntas para acompañar el texto y una guía de Lectio Divina.',
      ]),
      highlights_heading: 'Características comprobadas',
      highlights: Object.freeze([
        'Traducción interconfesional desde las lenguas originales.',
        '1.600 páginas en formato de 15 × 21 cm.',
        'Encuadernación rústica cosida con cubierta plastificada.',
        'Introducciones, mapas a color e ilustraciones.',
        'Vocabulario bíblico, lecturas y guía de Lectio Divina.',
      ]),
      decision_heading: '¿Esta es la edición que buscás?',
      decision_copy: 'Puede ser una opción si buscás una Biblia en español con introducciones, mapas y materiales para acompañar la lectura. Antes de comprar, compará el ISBN 9788490739808 y la encuadernación rústica con la edición que necesitás.',
      meta_description: 'La Biblia Palabra de Vida, ISBN 9788490739808: edición Hispanoamérica de Verbo Divino, 1.600 páginas, mapas y guía de Lectio Divina. Disponible en Uruguay.',
      merchant_description: 'La Biblia Palabra de Vida, edición Hispanoamérica de Editorial Verbo Divino. ISBN 9788490739808, 1.600 páginas, formato rústico cosido de 15 × 21 cm. Traducción interconfesional con introducciones, mapas, ilustraciones, vocabulario bíblico y guía de Lectio Divina.',
      links: Object.freeze([
        Object.freeze({ href: '/libros/biblias', label: 'Ver más Biblias disponibles' }),
        Object.freeze({ href: '/catalogo?categoria=religion-espiritualidad&subcategoria=biblia', label: 'Comparar otras ediciones' }),
      ]),
    }),
    facts: Object.freeze({
      publisher: 'Editorial Verbo Divino',
      pages: 1600,
      dimensions_text: '15 × 21 cm',
      bibliographic: Object.freeze({
        language: 'Español',
        format: 'Rústica cosida',
        edition: '2.ª edición (reimpresión 2)',
        collection: 'La Biblia. Palabra de Vida — Hispanoamérica',
      }),
    }),
    schema: Object.freeze({
      inLanguage: 'es',
      bookFormat: 'https://schema.org/Paperback',
      bookEdition: '2.ª edición (reimpresión 2)',
    }),
    provenance: Object.freeze([
      Object.freeze({
        type: 'publisher',
        provider: 'Editorial Verbo Divino',
        url: 'https://verbodivino.es/Libro/6735/la-biblia-palabra-de-vida',
        relationship: 'exact_edition',
        isbn: '9788490739808',
        verified_at: '2026-08-24',
        fields: Object.freeze([
          'description',
          'publisher',
          'pages',
          'dimensions',
          'format',
          'edition',
          'collection',
          'contents',
        ]),
      }),
      Object.freeze({
        type: 'commercial_reference',
        provider: 'Casa del Libro',
        url: 'https://www.casadellibro.com/libro-la-biblia-palabra-de-vida/9788490739808/16324741',
        relationship: 'exact_edition',
        isbn: '9788490739808',
        verified_at: '2026-08-24',
        fields: Object.freeze(['publisher', 'pages', 'language', 'format']),
      }),
    ]),
  }),
  Object.freeze({
    schema_version: 1,
    isbn: '9780825456459',
    decision: 'auto_publish',
    verified_at: '2026-08-24',
    editorial: Object.freeze({
      eyebrow: 'Biblia de estudio RVR60 · edición verificada',
      heading: 'Qué ofrece la Biblia de la mujer conforme al corazón de Dios',
      paragraphs: Object.freeze([
        'Esta Biblia de estudio utiliza el texto Reina-Valera 1960 y corresponde al ISBN 9780825456459. Es una edición de tapa dura publicada por Editorial Portavoz, con 1.680 páginas y un tamaño aproximado de 15,2 × 21,6 cm.',
        'Sus recursos están orientados al estudio y la lectura devocional: incluye introducciones a los libros bíblicos, biografías de mujeres y hombres de la Biblia, artículos y recuadros de sabiduría, lecciones de aplicación y 365 lecturas para acompañar un plan anual.',
      ]),
      highlights_heading: 'Características comprobadas',
      highlights: Object.freeze([
        'Texto bíblico Reina-Valera 1960.',
        '1.680 páginas y encuadernación de tapa dura.',
        'Introducciones a los libros de la Biblia.',
        'Biografías, artículos y recursos de aplicación.',
        '365 lecturas devocionales para el año.',
      ]),
      decision_heading: '¿Para qué tipo de lectura sirve?',
      decision_copy: 'Es una opción pensada para quien busca una Biblia RVR60 con recursos de estudio y devocionales dirigidos a la vida cotidiana de la mujer. Compará el ISBN 9780825456459 y la tapa dura antes de elegirla.',
      meta_description: 'Biblia de la mujer conforme al corazón de Dios RVR60, ISBN 9780825456459: tapa dura, 1.680 páginas y recursos de estudio. Disponible en Uruguay.',
      merchant_description: 'Biblia de la mujer conforme al corazón de Dios RVR60, Editorial Portavoz. ISBN 9780825456459, tapa dura y 1.680 páginas. Incluye introducciones, biografías, artículos, recursos de aplicación y 365 lecturas devocionales.',
      links: Object.freeze([
        Object.freeze({ href: '/libros/biblias/reina-valera', label: 'Comparar Biblias Reina-Valera' }),
        Object.freeze({ href: '/libros/biblias', label: 'Ver todas las Biblias disponibles' }),
      ]),
    }),
    facts: Object.freeze({
      publisher: 'Editorial Portavoz',
      pages: 1680,
      dimensions_text: '15,2 × 21,6 cm',
      bibliographic: Object.freeze({
        language: 'Español',
        format: 'Tapa dura',
        edition: 'Reina-Valera 1960',
      }),
    }),
    schema: Object.freeze({
      inLanguage: 'es',
      bookFormat: 'https://schema.org/Hardcover',
      bookEdition: 'Reina-Valera 1960',
    }),
    provenance: Object.freeze([
      Object.freeze({
        type: 'publisher',
        provider: 'Editorial Portavoz',
        url: 'https://www.portavoz.com/biblia-de-la-mujer-conforme-al-corazon-de-dios-rvr60-tapa-dura',
        relationship: 'exact_edition',
        isbn: '9780825456459',
        verified_at: '2026-08-24',
        fields: Object.freeze(['description', 'publisher', 'pages', 'dimensions', 'format', 'bible_version', 'contents']),
      }),
    ]),
  }),
  Object.freeze({
    schema_version: 1,
    isbn: '9781535908160',
    decision: 'auto_publish',
    verified_at: '2026-08-24',
    editorial: Object.freeze({
      eyebrow: 'Biblia especializada RVR60 · edición verificada',
      heading: 'Cómo está organizada la Biblia del Pescador letra grande',
      paragraphs: Object.freeze([
        'Esta edición en tapa dura de la Biblia del Pescador utiliza el texto Reina-Valera 1960 y corresponde al ISBN 9781535908160. Fue publicada por B&H Publishing Group, tiene 1.320 páginas, letra de 11 puntos y un formato aproximado de 15,7 × 23,4 cm.',
        'La propuesta combina el texto bíblico con una guía temática de 28 páginas. Sus cadenas de versículos están organizadas en seis áreas —consejería, devoción, evangelismo, iglesia, doctrina cristiana y apologética— para ayudar a localizar pasajes relacionados con situaciones y preguntas concretas.',
      ]),
      highlights_heading: 'Características comprobadas',
      highlights: Object.freeze([
        'Texto Reina-Valera 1960 con letra grande de 11 puntos.',
        '1.320 páginas y encuadernación de tapa dura.',
        'Guía temática de 28 páginas.',
        'Seis áreas de consulta mediante cadenas de versículos.',
        'Edición revisada y ampliada con nuevos temas y referencias.',
      ]),
      decision_heading: '¿Cuándo conviene esta edición?',
      decision_copy: 'Puede servir si buscás una RVR60 de letra grande con herramientas para encontrar pasajes por tema, preparar conversaciones o acompañar tareas de estudio y ministerio. Verificá el ISBN 9781535908160 y la tapa dura para distinguirla de las versiones en símil piel.',
      meta_description: 'Biblia del Pescador RVR60 letra grande, ISBN 9781535908160: tapa dura, 1.320 páginas y guía temática. Disponible en Uruguay.',
      merchant_description: 'Biblia del Pescador RVR60 letra grande, B&H Publishing Group. ISBN 9781535908160, tapa dura, 1.320 páginas y letra de 11 puntos. Incluye una guía temática de 28 páginas con cadenas de versículos.',
      links: Object.freeze([
        Object.freeze({ href: '/libros/biblias/reina-valera', label: 'Comparar Biblias Reina-Valera' }),
        Object.freeze({ href: '/libros/biblias', label: 'Ver todas las Biblias disponibles' }),
      ]),
    }),
    facts: Object.freeze({
      publisher: 'B&H Publishing Group',
      pages: 1320,
      dimensions_text: '15,7 × 23,4 cm',
      bibliographic: Object.freeze({
        language: 'Español',
        format: 'Tapa dura',
        edition: 'Reina-Valera 1960 · edición revisada y ampliada',
      }),
    }),
    schema: Object.freeze({
      inLanguage: 'es',
      bookFormat: 'https://schema.org/Hardcover',
      bookEdition: 'Reina-Valera 1960 · edición revisada y ampliada',
    }),
    provenance: Object.freeze([
      Object.freeze({
        type: 'publisher',
        provider: 'B&H Español',
        url: 'https://bhespanol.bhpublishinggroup.com/product/rvr-1960-biblia-del-pescador-letra-grande/rvr-1960-biblia-del-pescador-letra-grande-tapa-dura/',
        relationship: 'exact_edition',
        isbn: '9781535908160',
        verified_at: '2026-08-24',
        fields: Object.freeze(['description', 'publisher', 'pages', 'dimensions', 'format', 'bible_version', 'contents']),
      }),
    ]),
  }),
]);

export function validateBookEnrichment(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const isbn = normalizeValidIsbn(record.isbn);
  if (!isbn || isbn !== record.isbn || record.schema_version !== 1) return false;
  if (record.decision !== 'auto_publish') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(record.verified_at))) return false;
  if (!Array.isArray(record.editorial?.paragraphs) || record.editorial.paragraphs.length < 1) return false;
  if (record.editorial.paragraphs.some(paragraph => clean(paragraph).length < 80)) return false;
  if (!Array.isArray(record.provenance) || record.provenance.length < 1) return false;
  const exactOfficial = record.provenance.some(source =>
    source?.type === 'publisher' &&
    source?.relationship === 'exact_edition' &&
    normalizeValidIsbn(source?.isbn) === isbn &&
    /^https:\/\//i.test(clean(source?.url)),
  );
  if (!exactOfficial) return false;
  return record.provenance.every(source =>
    SOURCE_TYPES.has(source?.type) &&
    source?.relationship === 'exact_edition' &&
    normalizeValidIsbn(source?.isbn) === isbn &&
    /^https:\/\//i.test(clean(source?.url)) &&
    /^\d{4}-\d{2}-\d{2}$/.test(clean(source?.verified_at)) &&
    Array.isArray(source?.fields) && source.fields.length > 0,
  );
}

const ENRICHMENT_BY_ISBN = new Map();
for (const record of BIBLE_ENRICHMENTS) {
  if (!validateBookEnrichment(record)) {
    throw new Error(`Enriquecimiento bibliográfico inválido para ${record?.isbn || 'ISBN desconocido'}.`);
  }
  if (ENRICHMENT_BY_ISBN.has(record.isbn)) {
    throw new Error(`ISBN duplicado en el registro de enriquecimiento: ${record.isbn}.`);
  }
  ENRICHMENT_BY_ISBN.set(record.isbn, record);
}

export function getBookEnrichmentByIsbn(value) {
  const isbn = normalizeValidIsbn(value);
  return isbn ? ENRICHMENT_BY_ISBN.get(isbn) || null : null;
}

export function applyBookEnrichment(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const enrichment = getBookEnrichmentByIsbn(item.isbn);
  if (!enrichment) return item;

  const facts = enrichment.facts || {};
  const bibliography = item.bibliographic && typeof item.bibliographic === 'object'
    ? item.bibliographic
    : {};

  // Lista blanca: únicamente campos editoriales. La expansión explícita
  // impide que una futura entrada del registro reemplace datos comerciales.
  return {
    ...item,
    description: enrichment.editorial.paragraphs.join('\n\n'),
    publisher: facts.publisher || item.publisher,
    pages: facts.pages || item.pages,
    dimensions_text: facts.dimensions_text || item.dimensions_text,
    bibliographic: {
      ...bibliography,
      ...(facts.bibliographic || {}),
    },
  };
}

export function listBookEnrichments() {
  return [...ENRICHMENT_BY_ISBN.values()];
}
