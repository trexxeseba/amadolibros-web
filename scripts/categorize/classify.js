// scripts/categorize/classify.js
//
// Clasifica un único registro {mlu, title, author, publisher, status}.
// Puro: no hace I/O, no conoce R2 ni el catálogo completo — run.js orquesta.
//
// Orden de resolución (ver CF-CATEGORÍAS-1 punto 5):
//   1. corrección manual (si existe, gana siempre, confidence 1, method 'manual')
//   2. señales de "no es libro" (objeto)
//   3. autor reconocido (alta confianza)
//   4. editorial/imprenta reconocida
//   5. frase de título distintiva (confianza media)
//   6. sin evidencia suficiente -> uncertain, sin categoría inventada

import { TYPES, isValidCategoryId } from './taxonomy.js';
import { MINED_AUTHOR_SIGNALS, KEYWORD_SIGNALS, OBJECT_SIGNALS, RULES_VERSION } from './rules.js';

const CONFIDENCE = {
  MANUAL: 1,
  AUTHOR: 0.9,
  PUBLISHER: 0.85,
  KEYWORD: 0.75,
  OBJECT: 0.85,
  OBJECT_WEAK: 0.6,
  OTHER_BOOKS: 0.5,
};

// Umbral bajo el cual needsReview queda en true incluso si hay categoría.
export const REVIEW_THRESHOLD = 0.75;

export function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Índices invertidos autor/editorial -> categoría, construidos una sola vez.
function buildAuthorIndex() {
  const index = new Map(); // normalizedAuthor -> categoryId
  for (const categoryId of Object.keys(MINED_AUTHOR_SIGNALS)) {
    for (const author of MINED_AUTHOR_SIGNALS[categoryId].authors) {
      const key = normalizeText(author);
      if (key.length < 4) continue; // evita falsos positivos de nombres de 1-2 letras
      if (!index.has(key)) index.set(key, categoryId);
    }
  }
  return index;
}

function buildPublisherIndex() {
  const index = new Map();
  for (const categoryId of Object.keys(MINED_AUTHOR_SIGNALS)) {
    for (const publisher of MINED_AUTHOR_SIGNALS[categoryId].publishers) {
      const key = normalizeText(publisher);
      if (key.length < 4) continue;
      if (!index.has(key)) index.set(key, categoryId);
    }
  }
  return index;
}

const AUTHOR_INDEX = buildAuthorIndex();
const PUBLISHER_INDEX = buildPublisherIndex();

// Coincidencia por conjunto de palabras, no por substring literal: los datos
// de MELI mezclan "Apellido, Nombre" y "Nombre Apellido" para la misma
// persona (ver rules.js) — un match de substring en orden fijo pierde la
// mitad de los casos reales. Exige que TODAS las palabras significativas
// (3+ letras) del lado más corto aparezcan en el otro lado.
function wordSetMatch(normalizedA, normalizedB) {
  const wordsA = normalizedA.split(' ').filter(w => w.length >= 3);
  const wordsB = normalizedB.split(' ').filter(w => w.length >= 3);
  if (wordsA.length === 0 || wordsB.length === 0) return false;
  const [shorter, longer] = wordsA.length <= wordsB.length ? [wordsA, wordsB] : [wordsB, wordsA];
  const longerSet = new Set(longer);
  return shorter.every(w => longerSet.has(w));
}

function findAuthorMatch(normalizedAuthor) {
  if (!normalizedAuthor) return null;
  for (const [key, categoryId] of AUTHOR_INDEX) {
    if (wordSetMatch(normalizedAuthor, key)) {
      return { categoryId, evidence: `autor coincide con lista conocida: "${key}"` };
    }
  }
  return null;
}

function findPublisherMatch(normalizedPublisher) {
  if (!normalizedPublisher) return null;
  for (const [key, categoryId] of PUBLISHER_INDEX) {
    if (wordSetMatch(normalizedPublisher, key)) {
      return { categoryId, evidence: `editorial coincide con lista conocida: "${key}"` };
    }
  }
  return null;
}

function findKeywordMatch(normalizedTitle) {
  for (const categoryId of Object.keys(KEYWORD_SIGNALS)) {
    for (const phrase of KEYWORD_SIGNALS[categoryId]) {
      const key = normalizeText(phrase);
      if (key && normalizedTitle.includes(key)) {
        return { categoryId, evidence: `título contiene frase distintiva: "${phrase}"` };
      }
    }
  }
  return null;
}

// Tokens de formato ambiguos si se buscan como substring ("cd" adentro de
// cualquier palabra), pero seguros si se exige que sean una palabra exacta
// del título ya tokenizado — normalizeText ya separa por espacios.
const OBJECT_FORMAT_TOKENS = ['cd', 'lp', 'dvd'];

function findObjectSignal(normalizedTitle) {
  for (const phrase of OBJECT_SIGNALS) {
    const key = normalizeText(phrase);
    if (key && normalizedTitle.includes(key)) {
      return phrase;
    }
  }
  const words = normalizedTitle.split(' ');
  for (const token of OBJECT_FORMAT_TOKENS) {
    if (words.includes(token)) return token;
  }
  return null;
}

/**
 * @param {{mlu:string, title:string, author?:string, publisher?:string, status:string}} record
 * @param {{type:string, categoryId:string|null, subcategoryId?:string|null, tags?:string[], note?:string}|null} manualCorrection
 * @returns {object} clasificación en el esquema de CF-CATEGORÍAS-1
 */
export function classify(record, manualCorrection = null) {
  const base = {
    mlu: record.mlu,
    taxonomyVersion: 1,
    rulesVersion: RULES_VERSION,
  };

  if (manualCorrection) {
    return {
      ...base,
      type: manualCorrection.type,
      categoryId: manualCorrection.categoryId,
      subcategoryId: manualCorrection.subcategoryId ?? null,
      tags: manualCorrection.tags ?? [],
      confidence: CONFIDENCE.MANUAL,
      method: 'manual',
      evidence: [manualCorrection.note || 'corrección manual'],
      needsReview: false,
    };
  }

  const normalizedTitle = normalizeText(record.title);
  const normalizedAuthor = normalizeText(record.author);
  const normalizedPublisher = normalizeText(record.publisher);

  const hasAuthor = Boolean(normalizedAuthor);
  const hasIsbn = Boolean(record.isbn);

  const objectSignal = findObjectSignal(normalizedTitle);
  const authorMatch = findAuthorMatch(normalizedAuthor);
  const publisherMatch = findPublisherMatch(normalizedPublisher);

  // Objeto: si hay señal de objeto Y (no hay autor reconocido de libro que la
  // contradiga) — igual que en el criterio manual usado en CF-CATEGORÍAS-0B:
  // "objeto" cuando la señal aparece y falta autor/ISBN; "dudoso" cuando la
  // señal aparece pero el resto de los datos sugiere que sí es un libro.
  if (objectSignal && !authorMatch && !publisherMatch) {
    if (!hasAuthor || !hasIsbn) {
      return {
        ...base,
        type: TYPES.OBJECT,
        categoryId: null,
        subcategoryId: null,
        tags: [],
        confidence: CONFIDENCE.OBJECT,
        method: 'rule',
        evidence: [`título contiene señal de objeto: "${objectSignal}"`, !hasAuthor ? 'sin autor' : 'sin ISBN'],
        needsReview: false,
      };
    }
    return {
      ...base,
      type: TYPES.UNCERTAIN,
      categoryId: null,
      subcategoryId: null,
      tags: [],
      confidence: CONFIDENCE.OBJECT_WEAK,
      method: 'rule',
      evidence: [`título contiene señal de objeto: "${objectSignal}"`, 'pero tiene autor e ISBN — podría ser un libro sobre el tema'],
      needsReview: true,
    };
  }

  if (authorMatch) {
    return {
      ...base,
      type: TYPES.BOOK,
      categoryId: authorMatch.categoryId,
      subcategoryId: null,
      tags: [],
      confidence: CONFIDENCE.AUTHOR,
      method: 'rule',
      evidence: [authorMatch.evidence],
      needsReview: false,
    };
  }

  if (publisherMatch) {
    return {
      ...base,
      type: TYPES.BOOK,
      categoryId: publisherMatch.categoryId,
      subcategoryId: null,
      tags: [],
      confidence: CONFIDENCE.PUBLISHER,
      method: 'rule',
      evidence: [publisherMatch.evidence],
      needsReview: false,
    };
  }

  const keywordMatch = findKeywordMatch(normalizedTitle);
  if (keywordMatch) {
    return {
      ...base,
      type: TYPES.BOOK,
      categoryId: keywordMatch.categoryId,
      subcategoryId: null,
      tags: [],
      confidence: CONFIDENCE.KEYWORD,
      method: 'rule',
      evidence: [keywordMatch.evidence],
      needsReview: false,
    };
  }

  // Sin coincidencia de materia — pero si hay evidencia razonable de que es
  // un libro real (autor o ISBN cargado, y ninguna señal de objeto) cae en
  // "otros-libros" en vez de quedar fuera del catálogo público (CF-CATEGORÍAS-2
  // punto "libro real sin categoría suficientemente clara"). Sin esa mínima
  // evidencia, no se afirma que sea un libro — queda uncertain, sin categoría,
  // para revisión (podría ser objeto/revista/disco sin señal de título).
  if (!objectSignal && (hasAuthor || hasIsbn)) {
    return {
      ...base,
      type: TYPES.BOOK,
      categoryId: 'otros-libros',
      subcategoryId: null,
      tags: [],
      confidence: CONFIDENCE.OTHER_BOOKS,
      method: 'rule',
      evidence: [
        'sin coincidencia de autor/editorial/frase conocida',
        hasAuthor ? 'tiene autor cargado' : 'tiene ISBN cargado',
      ],
      needsReview: true,
    };
  }

  return {
    ...base,
    type: TYPES.UNCERTAIN,
    categoryId: null,
    subcategoryId: null,
    tags: [],
    confidence: 0,
    method: 'rule',
    evidence: ['sin coincidencia de autor, editorial ni frase de título conocida, y sin autor/ISBN que respalde que sea un libro'],
    needsReview: true,
  };
}

export function validateClassification(result) {
  const errors = [];
  if (!isValidCategoryId(result.categoryId)) errors.push(`categoryId inválido: ${result.categoryId}`);
  if (result.type === TYPES.OBJECT && result.categoryId !== null) {
    errors.push('un objeto no puede tener categoryId (no es libro)');
  }
  if (result.type === TYPES.UNCERTAIN && result.categoryId !== null) {
    errors.push('un caso dudoso no debe recibir categoría inventada');
  }
  if (result.type === TYPES.BOOK && result.categoryId === null) {
    errors.push('un libro resuelto debe tener categoryId');
  }
  return errors;
}
