import { applyVerifiedDemandBibliography } from './verified-demand-bibliography.js';

/**
 * Datos bibliográficos revisados manualmente para lotes pequeños de fichas.
 *
 * Reglas:
 * - la publicación de ML y el ISBN deben identificar la misma edición;
 * - nunca se modifica el título comercial;
 * - las descripciones son redacción propia de Amado Libros;
 * - las fotos no se sustituyen: deben provenir del ejemplar real.
 */

const VERIFIED_BOOK_ENRICHMENTS = new Map([
  ['MLU644161565', {
    isbn: '9781074092290',
    author: 'Laura Vidal',
    publisher: 'Independently published',
    pages: 128,
    bibliographic: {
      language: 'Español',
      format: 'Tapa blanda',
      edition: '1.ª edición',
      publication_year: '2019',
      genre: 'Duelo y mascotas',
      subtitle: 'Cómo afrontar el duelo por la pérdida de tu mascota',
    },
    dimensions: { width: '14 cm', height: '21 cm' },
    description: 'Una guía para quienes atraviesan la pérdida de un animal de compañía. Laura Vidal combina experiencias y orientaciones sobre las etapas del duelo, la empatía, la resiliencia y el momento de abrirse a un nuevo vínculo. También ofrece un punto de partida para familias que necesitan acompañar a niños ante la muerte de una mascota.',
  }],
  ['MLU678034726', {
    isbn: '9788433031143',
    author: 'Eve Caligor, Otto F. Kernberg, John F. Clarkin y Frank E. Yeomans',
    publisher: 'Desclée De Brouwer',
    pages: 672,
    bibliographic: {
      language: 'Español',
      format: 'Tapa blanda',
      publication_year: '2020',
      genre: 'Psicología clínica',
      collection: 'Biblioteca de Psicología',
    },
    dimensions: { width: '17 cm', height: '24 cm' },
    description: 'Texto clínico que integra teoría psicodinámica, evaluación y tratamiento de los trastornos de la personalidad. Presenta un marco para comprender el funcionamiento de la personalidad y desarrollar intervenciones aplicables en distintos contextos clínicos, incluida la Psicoterapia Focalizada en la Transferencia ampliada. Está dirigido especialmente a psicólogos, psiquiatras, psicoterapeutas y estudiantes avanzados.',
  }],
  ['MLU1467827214', {
    isbn: '9788493774301',
    author: 'Francine Shapiro, Florence W. Kaslow y Louise Maxfield',
    publisher: 'Ediciones Pléyades',
    pages: 632,
    bibliographic: {
      language: 'Español',
      format: 'Tapa dura',
      publication_year: '2012',
      genre: 'Psicología clínica',
    },
    description: 'Manual clínico sobre la integración del procesamiento de información de EMDR con perspectivas y técnicas de terapia familiar. Reúne fundamentos, orientación práctica y casos para trabajar con individuos, parejas y familias. Es una obra de consulta para profesionales y estudiantes avanzados que buscan comprender cómo articular ambos enfoques dentro de una formulación terapéutica coherente.',
  }],
  ['MLU633677061', {
    isbn: '9788449341281',
    author: 'Jean Laplanche y Jean-Bertrand Pontalis',
    publisher: 'Ediciones Paidós',
    pages: 592,
    bibliographic: {
      language: 'Español',
      format: 'Tapa blanda',
      publication_year: '2023',
      genre: 'Psicoanálisis',
      collection: 'Psicología, Psiquiatría y Psicoterapia',
      subtitle: 'Bajo la dirección de Daniel Lagache',
    },
    dimensions: { width: '15.5 cm', height: '23.3 cm', weight: '857 g' },
    description: 'Obra de referencia de Jean Laplanche y Jean-Bertrand Pontalis para estudiar el vocabulario y la evolución conceptual del psicoanálisis. Cada entrada combina definición, historia, estructura y problemas teóricos, con referencias cruzadas y equivalencias terminológicas en varios idiomas. Resulta especialmente útil para estudiantes, docentes y profesionales que necesitan una fuente de consulta sistemática.',
  }],
  ['MLU1304008698', {
    isbn: '9788433028839',
    author: 'Frank E. Yeomans, John F. Clarkin y Otto F. Kernberg',
    publisher: 'Desclée De Brouwer',
    pages: 608,
    bibliographic: {
      language: 'Español',
      format: 'Tapa blanda',
      edition: '2.ª edición',
      publication_year: '2016',
      genre: 'Psicología clínica',
      collection: 'Biblioteca de Psicología',
    },
    dimensions: { width: '15 cm', height: '21 cm' },
    description: 'Guía clínica de Psicoterapia Centrada en la Transferencia para el abordaje del trastorno límite y otras organizaciones graves de la personalidad. Los autores desarrollan la selección de casos, el encuadre, el análisis de la transferencia y el manejo de crisis mediante ejemplos clínicos. Está orientada a profesionales y estudiantes avanzados de psicología, psiquiatría y psicoterapia.',
  }],
]);

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * Aplica el lote manual solo cuando el ID coincide y el ISBN no contradice la
 * ficha. Después completa, en modo fill-only, los campos confirmados para la
 * cohorte de demanda. Devuelve métricas para que el sync deje evidencia de lo
 * aplicado/omitido.
 */
export function applyVerifiedBookEnrichments(items = []) {
  let applied = 0;
  let skippedIsbnMismatch = 0;

  for (const item of items) {
    const enrichment = VERIFIED_BOOK_ENRICHMENTS.get(String(item?.id || ''));
    if (!enrichment) continue;

    const currentIsbn = digits(item.isbn);
    const verifiedIsbn = digits(enrichment.isbn);
    if (currentIsbn && currentIsbn !== verifiedIsbn) {
      skippedIsbnMismatch++;
      continue;
    }

    const originalTitle = item.title;
    item.isbn = enrichment.isbn;
    item.author = enrichment.author;
    item.publisher = enrichment.publisher;
    item.pages = enrichment.pages;
    item.bibliographic = {
      ...(item.bibliographic || {}),
      ...enrichment.bibliographic,
    };
    item.dimensions = {
      ...(enrichment.dimensions || {}),
      ...(item.dimensions || {}),
    };
    item.description = enrichment.description;
    item.title = originalTitle;
    applied++;
  }

  const demandBibliography = applyVerifiedDemandBibliography(items);

  return {
    applied,
    skipped_isbn_mismatch: skippedIsbnMismatch,
    demand_bibliography: demandBibliography,
  };
}

export const VERIFIED_BOOK_IDS = Object.freeze([...VERIFIED_BOOK_ENRICHMENTS.keys()]);
