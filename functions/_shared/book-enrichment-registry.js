// FICHAS-ENRICHMENT-BIBLIAS-1
//
// Registro editorial por EDICIÓN (ISBN-13), nunca por publicación MLU.
// Una investigación se reutiliza en todos los duplicados compatibles, pero
// sólo puede aportar datos bibliográficos y copy editorial: precio, stock,
// condición, imágenes, título comercial, id y URL permanecen en el catálogo.

import { BOOK_FACT_ENRICHMENTS } from './book-enrichment-facts-1000.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_333 } from './book-enrichment-facts-333.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_LOTE_01 } from './book-enrichment-facts-lote-01.js';
import { BOOK_FACT_ENRICHMENTS as BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01 } from './book-enrichment-facts-b11-2-lote-01.js';
import { BOOK_EDITORIAL_UPGRADES } from './book-editorial-upgrades.js';
import { isGenericAuthor, normalizeValidIsbn } from './showcase-ranking.js';

const SOURCE_TYPES = new Set([
  'publisher',
  'national_library',
  'library_catalog',
  'bibliographic_database',
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
  Object.freeze({
    schema_version: 1,
    isbn: '9781087701417',
    decision: 'auto_publish',
    verified_at: '2026-08-24',
    editorial: Object.freeze({
      eyebrow: 'Biblia cronológica RVR60 · edición verificada',
      heading: 'Cómo se lee la Biblia cronológica día por día',
      paragraphs: Object.freeze([
        'Esta Biblia Reina-Valera 1960 organiza el texto completo según la secuencia cronológica de los acontecimientos y corresponde al ISBN 9781087701417. Es una edición de B&H Español en símil piel, con 1.424 páginas, letra de 9 puntos y un formato aproximado de 17 × 22,9 cm.',
        'El recorrido está distribuido en 52 semanas de lectura devocional y puede comenzarse en cualquier momento del año. Incluye introducciones, texto en una columna, margen para anotaciones y mapas a color para acompañar la comprensión del relato bíblico.',
      ]),
      highlights_heading: 'Características comprobadas',
      highlights: Object.freeze([
        'Texto Reina-Valera 1960 ordenado cronológicamente.',
        '52 semanas de lectura devocional sin fechas fijas.',
        '1.424 páginas con letra de 9 puntos.',
        'Texto en una columna y margen para anotaciones.',
        'Introducciones y mapas a color.',
      ]),
      decision_heading: '¿Para quién resulta útil?',
      decision_copy: 'Es una alternativa para quien quiere seguir la historia bíblica en orden cronológico y sostener un plan de lectura semanal. Compará el ISBN 9781087701417 y la cubierta marrón en símil piel antes de comprar.',
      meta_description: 'Biblia cronológica día por día RVR60, ISBN 9781087701417: 1.424 páginas, 52 semanas de lectura y mapas. Disponible en Uruguay.',
      merchant_description: 'Biblia cronológica día por día RVR60 de B&H Español. ISBN 9781087701417, símil piel, 1.424 páginas y letra de 9 puntos. Incluye 52 semanas de lectura, margen para notas, introducciones y mapas a color.',
      links: Object.freeze([
        Object.freeze({ href: '/libros/biblias/reina-valera', label: 'Comparar Biblias Reina-Valera' }),
        Object.freeze({ href: '/libros/biblias', label: 'Ver todas las Biblias disponibles' }),
      ]),
    }),
    facts: Object.freeze({
      publisher: 'B&H Español',
      pages: 1424,
      dimensions_text: '17 × 22,9 cm',
      bibliographic: Object.freeze({
        language: 'Español',
        format: 'Símil piel',
        edition: 'Reina-Valera 1960 · edición cronológica',
      }),
    }),
    schema: Object.freeze({
      inLanguage: 'es',
      bookEdition: 'Reina-Valera 1960 · edición cronológica',
    }),
    provenance: Object.freeze([
      Object.freeze({
        type: 'publisher',
        provider: 'B&H Español',
        url: 'https://bhespanol.bhpublishinggroup.com/product/rvr-1960-biblia-cronologica-dia-por-dia-marron-simil-piel/',
        relationship: 'exact_edition',
        isbn: '9781087701417',
        verified_at: '2026-08-24',
        fields: Object.freeze(['description', 'publisher', 'pages', 'dimensions', 'format', 'bible_version', 'contents']),
      }),
    ]),
  }),
  Object.freeze({
    schema_version: 1,
    isbn: '9781430091899',
    decision: 'auto_publish',
    verified_at: '2026-08-24',
    editorial: Object.freeze({
      eyebrow: 'Biblia letra gigante RVR60 · edición verificada',
      heading: 'Qué incluye esta RVR60 de letra gigante',
      paragraphs: Object.freeze([
        'Esta edición floreada en símil piel utiliza el texto Reina-Valera 1960 y corresponde al ISBN 9781430091899. Fue publicada por B&H Español en 2024, tiene 1.728 páginas, letra gigante de 14 puntos y un formato aproximado de 17,3 × 24,9 cm.',
        'Además del tamaño de letra, incorpora referencias en cadena, concordancia temática, panorama histórico, plan de lectura anual, introducciones y bosquejos de cada libro, palabras de Cristo en rojo y mapas a color.',
      ]),
      highlights_heading: 'Características comprobadas',
      highlights: Object.freeze([
        'Texto Reina-Valera 1960 con letra gigante de 14 puntos.',
        '1.728 páginas y cubierta floreada en símil piel.',
        'Referencias en cadena y concordancia temática.',
        'Plan de lectura anual e introducciones por libro.',
        'Palabras de Cristo en rojo y mapas a color.',
      ]),
      decision_heading: '¿Cuándo elegir letra gigante?',
      decision_copy: 'Puede convenir si priorizás una tipografía grande para lectura personal, enseñanza o lectura pública y querés conservar ayudas de referencia. Verificá el ISBN 9781430091899 y el diseño floreado para distinguir esta edición.',
      meta_description: 'Biblia RVR60 letra gigante floreada, ISBN 9781430091899: 14 puntos, 1.728 páginas y símil piel. Disponible en Uruguay.',
      merchant_description: 'Biblia RVR60 letra gigante floreada de B&H Español. ISBN 9781430091899, símil piel, 1.728 páginas y tipografía de 14 puntos. Incluye referencias, concordancia, plan anual, introducciones y mapas a color.',
      links: Object.freeze([
        Object.freeze({ href: '/libros/biblias/reina-valera', label: 'Comparar Biblias Reina-Valera' }),
        Object.freeze({ href: '/libros/biblias', label: 'Ver todas las Biblias disponibles' }),
      ]),
    }),
    facts: Object.freeze({
      publisher: 'B&H Español',
      pages: 1728,
      dimensions_text: '17,3 × 24,9 cm',
      bibliographic: Object.freeze({
        language: 'Español',
        format: 'Símil piel',
        edition: 'Reina-Valera 1960 · edición 2024',
      }),
    }),
    schema: Object.freeze({
      inLanguage: 'es',
      bookEdition: 'Reina-Valera 1960 · edición 2024',
    }),
    provenance: Object.freeze([
      Object.freeze({
        type: 'publisher',
        provider: 'B&H Español',
        url: 'https://bhespanol.bhpublishinggroup.com/product/rvr-1960-biblia-letra-gigante-floreada-simil-piel-edicion-2023/',
        relationship: 'exact_edition',
        isbn: '9781430091899',
        verified_at: '2026-08-24',
        fields: Object.freeze(['description', 'publisher', 'pages', 'dimensions', 'format', 'bible_version', 'text_size', 'contents']),
      }),
    ]),
  }),
  Object.freeze({
    schema_version: 1,
    isbn: '9781535998000',
    decision: 'auto_publish',
    verified_at: '2026-08-24',
    editorial: Object.freeze({
      eyebrow: 'Biblia devocional RVR60 · edición verificada',
      heading: 'Qué propone la Biblia devocional Centrada en Cristo',
      paragraphs: Object.freeze([
        'Esta edición para mujeres utiliza el texto Reina-Valera 1960 y corresponde al ISBN 9781535998000. Fue publicada por B&H Español en símil piel floreado, tiene 1.792 páginas, letra de 9,5 puntos y un formato aproximado de 15,6 × 23,2 cm.',
        'Su recorrido devocional conecta el relato de Cristo con los distintos libros de la Biblia. Incluye 365 devocionales escritos por mujeres hispanas, planes de lectura devocional y anual, concordancia, ilustraciones a color y cinta marcadora.',
      ]),
      highlights_heading: 'Características comprobadas',
      highlights: Object.freeze([
        'Texto Reina-Valera 1960 en edición devocional para mujeres.',
        '365 devocionales y dos planes de lectura.',
        '1.792 páginas con letra de 9,5 puntos.',
        'Concordancia e ilustraciones a color.',
        'Cubierta floreada en símil piel y cinta marcadora.',
      ]),
      decision_heading: '¿Qué experiencia de lectura ofrece?',
      decision_copy: 'Está pensada para quien busca una RVR60 con un acompañamiento devocional diario y una perspectiva desarrollada por mujeres hispanas. Compará el ISBN 9781535998000 y la cubierta floreada antes de elegirla.',
      meta_description: 'Biblia devocional Centrada en Cristo RVR60, ISBN 9781535998000: 365 devocionales y 1.792 páginas. Disponible en Uruguay.',
      merchant_description: 'Biblia devocional para mujeres Centrada en Cristo RVR60 de B&H Español. ISBN 9781535998000, símil piel, 1.792 páginas y letra de 9,5 puntos. Incluye 365 devocionales, planes de lectura, concordancia e ilustraciones.',
      links: Object.freeze([
        Object.freeze({ href: '/libros/biblias/reina-valera', label: 'Comparar Biblias Reina-Valera' }),
        Object.freeze({ href: '/libros/biblias', label: 'Ver todas las Biblias disponibles' }),
      ]),
    }),
    facts: Object.freeze({
      publisher: 'B&H Español',
      pages: 1792,
      dimensions_text: '15,6 × 23,2 cm',
      bibliographic: Object.freeze({
        language: 'Español',
        format: 'Símil piel',
        edition: 'Reina-Valera 1960 · edición devocional',
      }),
    }),
    schema: Object.freeze({
      inLanguage: 'es',
      bookEdition: 'Reina-Valera 1960 · edición devocional',
    }),
    provenance: Object.freeze([
      Object.freeze({
        type: 'publisher',
        provider: 'B&H Español',
        url: 'https://bhespanol.bhpublishinggroup.com/product/rvr1960-centrada-en-cristo-floral-simil-piel/',
        relationship: 'exact_edition',
        isbn: '9781535998000',
        verified_at: '2026-08-24',
        fields: Object.freeze(['description', 'publisher', 'pages', 'dimensions', 'format', 'bible_version', 'text_size', 'contents']),
      }),
    ]),
  }),
]);

export function validateBookEnrichment(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  const isbn = normalizeValidIsbn(record.isbn);
  if (!isbn || isbn !== record.isbn || record.schema_version !== 1) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(record.verified_at))) return false;
  if (record.decision === 'auto_publish_facts') {
    if (record.sample_listing_id !== null && record.sample_listing_id !== undefined &&
        !/^MLU\d+$/.test(clean(record.sample_listing_id).toUpperCase())) return false;
    const facts = record.facts && typeof record.facts === 'object' && !Array.isArray(record.facts)
      ? record.facts
      : null;
    if (!facts || Object.keys(facts).length < 1) return false;
    if (Object.keys(facts).some(field => !['author', 'publisher', 'pages', 'bibliographic'].includes(field))) return false;
    if (facts.bibliographic && Object.keys(facts.bibliographic)
      .some(field => !['language', 'format', 'edition', 'publication_year', 'subjects'].includes(field))) return false;
    if (!Array.isArray(record.provenance) || record.provenance.length < 1) return false;
    const flatFields = [
      facts.author ? 'author' : null,
      facts.publisher ? 'publisher' : null,
      Number(facts.pages) > 0 ? 'pages' : null,
      ...Object.keys(facts.bibliographic || {}).map(field => field === 'subjects' ? 'topics' : field),
    ].filter(Boolean);
    if (!flatFields.length) return false;
    for (const field of flatFields) {
      const supporters = record.provenance.filter(source => source?.fields?.includes(field));
      const hasOfficial = supporters.some(source => ['publisher', 'national_library'].includes(source?.type));
      const independentProviders = new Set(supporters.map(source => clean(source?.provider)).filter(Boolean));
      if (!hasOfficial && independentProviders.size < 2) return false;
    }
    return record.provenance.every(source =>
      SOURCE_TYPES.has(source?.type) &&
      source?.relationship === 'exact_edition' &&
      normalizeValidIsbn(source?.isbn) === isbn &&
      /^https:\/\//i.test(clean(source?.url)) &&
      /^\d{4}-\d{2}-\d{2}$/.test(clean(source?.verified_at)) &&
      Array.isArray(source?.fields) && source.fields.length > 0,
    );
  }
  if (record.decision !== 'auto_publish') return false;
  if (!Array.isArray(record.editorial?.paragraphs) || record.editorial.paragraphs.length < 1) return false;
  if (record.editorial.paragraphs.some(paragraph => clean(paragraph).length < 80)) return false;
  if (!Array.isArray(record.provenance) || record.provenance.length < 1) return false;

  const isEditorialReal = record.editorial?.quality_level === 'editorial_real_v1';
  if (isEditorialReal) {
    const editorialText = record.editorial.paragraphs.map(clean).join(' ');
    if (record.editorial.paragraphs.length < 2 || editorialText.length < 450) return false;
    if (!Array.isArray(record.editorial.highlights) || record.editorial.highlights.length < 5) return false;
    if (record.editorial.highlights.some(value => clean(value).length < 25)) return false;
    if (clean(record.editorial.decision_copy).length < 180) return false;
    const metaLength = clean(record.editorial.meta_description).length;
    if (metaLength < 80 || metaLength > 170) return false;
    if (clean(record.editorial.merchant_description).length < 250) return false;
    if (!clean(record.editorial.seo_title) || !clean(record.editorial.heading)) return false;

    const exactEditionSources = record.provenance.filter(source =>
      source?.relationship === 'exact_edition' &&
      normalizeValidIsbn(source?.isbn) === isbn
    );
    const exactProviders = new Set(exactEditionSources.map(source => clean(source?.provider)).filter(Boolean));
    const sourceEditionPublisher = record.provenance.some(source =>
      source?.type === 'publisher' &&
      source?.relationship === 'source_edition' &&
      normalizeValidIsbn(source?.isbn) &&
      /^https:\/\//i.test(clean(source?.url))
    );
    if (exactProviders.size < 2 || !sourceEditionPublisher) return false;

    return record.provenance.every(source => {
      if (!SOURCE_TYPES.has(source?.type)) return false;
      if (!['exact_edition', 'source_edition'].includes(source?.relationship)) return false;
      const sourceIsbn = normalizeValidIsbn(source?.isbn);
      if (!sourceIsbn) return false;
      if (source.relationship === 'exact_edition' && sourceIsbn !== isbn) return false;
      if (!/^https:\/\//i.test(clean(source?.url))) return false;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(source?.verified_at))) return false;
      return Array.isArray(source?.fields) && source.fields.length > 0;
    });
  }

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
for (const record of BOOK_FACT_ENRICHMENTS) {
  if (!validateBookEnrichment(record)) {
    throw new Error(`Enriquecimiento factual inválido para ${record?.isbn || 'ISBN desconocido'}.`);
  }
  if (ENRICHMENT_BY_ISBN.has(record.isbn)) {
    throw new Error(`ISBN duplicado en el registro de enriquecimiento: ${record.isbn}.`);
  }
  ENRICHMENT_BY_ISBN.set(record.isbn, record);
}
for (const record of BOOK_FACT_ENRICHMENTS_333) {
  if (!validateBookEnrichment(record)) {
    throw new Error(`Enriquecimiento factual inválido para ${record?.isbn || 'ISBN desconocido'}.`);
  }
  if (ENRICHMENT_BY_ISBN.has(record.isbn)) {
    throw new Error(`ISBN duplicado en el registro de enriquecimiento: ${record.isbn}.`);
  }
  ENRICHMENT_BY_ISBN.set(record.isbn, record);
}
for (const record of BOOK_FACT_ENRICHMENTS_LOTE_01) {
  if (!validateBookEnrichment(record)) {
    throw new Error(`Enriquecimiento factual inválido para ${record?.isbn || 'ISBN desconocido'}.`);
  }
  if (ENRICHMENT_BY_ISBN.has(record.isbn)) {
    throw new Error(`ISBN duplicado en el registro de enriquecimiento: ${record.isbn}.`);
  }
  ENRICHMENT_BY_ISBN.set(record.isbn, record);
}
// B11.2: ISBN que B11.1 dejó en REVISAR, resueltos por consenso cruzado de
// fuentes independientes (scripts/seo/b11-2-resolve-revisar.mjs).
for (const record of BOOK_FACT_ENRICHMENTS_B11_2_LOTE_01) {
  if (!validateBookEnrichment(record)) {
    throw new Error(`Enriquecimiento factual inválido para ${record?.isbn || 'ISBN desconocido'}.`);
  }
  if (ENRICHMENT_BY_ISBN.has(record.isbn)) {
    throw new Error(`ISBN duplicado en el registro de enriquecimiento: ${record.isbn}.`);
  }
  ENRICHMENT_BY_ISBN.set(record.isbn, record);
}

// Una mejora editorial reemplaza el registro factual de la misma edición,
// pero no crea una edición nueva ni altera la métrica de cobertura por ISBN.
for (const record of BOOK_EDITORIAL_UPGRADES) {
  if (!validateBookEnrichment(record)) {
    throw new Error(`Enriquecimiento editorial real inválido para ${record?.isbn || 'ISBN desconocido'}.`);
  }
  if (!ENRICHMENT_BY_ISBN.has(record.isbn)) {
    throw new Error(`La mejora editorial debe corresponder a un ISBN ya investigado: ${record.isbn}.`);
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
  const editorialDescription = Array.isArray(enrichment?.editorial?.paragraphs)
    ? enrichment.editorial.paragraphs.map(clean).filter(Boolean).join('\n\n')
    : '';
  return {
    ...item,
    author: facts.author && isGenericAuthor(item.author) ? facts.author : item.author,
    description: editorialDescription || item.description,
    // El enriquecimiento masivo completa ausencias: nunca reemplaza un dato
    // bibliográfico que ya llegó confirmado en la publicación original.
    publisher: item.publisher || facts.publisher,
    pages: item.pages || facts.pages,
    dimensions_text: item.dimensions_text || facts.dimensions_text,
    bibliographic: {
      ...(facts.bibliographic || {}),
      ...bibliography,
    },
    // Metadatos internos para el render SSR. No contienen precio, stock,
    // imágenes ni URL comercial y no se escriben de vuelta al catálogo.
    _amadoEditorial: enrichment.decision === 'auto_publish' ? enrichment.editorial : null,
    _amadoSchema: enrichment.schema || null,
    _amadoEnrichmentLevel: enrichment.editorial?.quality_level === 'editorial_real_v1'
      ? 'editorial_real'
      : enrichment.decision === 'auto_publish' ? 'editorial_curated' : 'bibliographic',
  };
}

export function listBookEnrichments() {
  return [...ENRICHMENT_BY_ISBN.values()];
}
