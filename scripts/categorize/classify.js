// scripts/categorize/classify.js
//
// Clasifica un único registro {mlu, title, author, publisher, isbn, status}.
// Puro: no hace I/O, no conoce el catálogo completo — run.js orquesta.
//
// CF-CATEGORÍAS-2C: esquema nuevo (primaryCategoryId/subcategoryId/
// secondaryCategoryIds/tags), y ningún activo queda sin categoría pública —
// "uncertain" ya no es un tipo válido de salida; el peor caso es
// "otros-libros" (si hay evidencia de que es un libro real) u
// "otros-productos" (si no la hay, o si hay señal de que no es un libro).
// El nivel de confianza/método/evidencia se calculan igual que antes, pero
// son solo para uso interno (auditoría, cola de revisión) — nunca se
// muestran al cliente.
//
// Orden de resolución (CF-CATEGORÍAS-2C punto 4):
//   1. corrección manual (si existe, gana siempre)
//   2. tipo música/revista/objeto con subcategoría específica
//   3. autor reconocido (alta confianza)
//   4. editorial/imprenta reconocida
//   5. frase de título distintiva, fuerte (con subcategoría cuando aplica)
//   6. frase de título distintiva, débil (segunda pasada, confianza menor)
//   7. objeto genérico (antigüedad/colección) sin autor/ISBN de por medio
//   8. sin evidencia de materia — pero SIEMPRE con categoría pública:
//      "otros-libros" si hay autor/ISBN, "otros-productos" si no.

import { TAXONOMY_VERSION, TYPES, isValidCategoryId, isValidSubcategoryId } from './taxonomy.js';
import {
  MINED_AUTHOR_SIGNALS,
  KEYWORD_SIGNALS,
  KEYWORD_SIGNALS_WEAK,
  OBJECT_SIGNALS,
  OBJECT_TYPE_SIGNALS,
  RULES_VERSION,
} from './rules.js';

const CONFIDENCE = {
  MANUAL: 1,
  AUTHOR: 0.9,
  PUBLISHER: 0.85,
  KEYWORD: 0.75,
  KEYWORD_WEAK: 0.55,
  OBJECT_TYPED: 0.85,
  OBJECT: 0.8,
  OBJECT_AMBIGUOUS: 0.5,
  OTHER_BOOKS: 0.45,
  OTHER_PRODUCTS: 0.4,
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

// ── Índices invertidos, construidos una sola vez ───────────────────────────
function buildAuthorIndex() {
  const index = new Map();
  for (const categoryId of Object.keys(MINED_AUTHOR_SIGNALS)) {
    for (const author of MINED_AUTHOR_SIGNALS[categoryId].authors) {
      const key = normalizeText(author);
      if (key.length < 4) continue;
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

// Encontrado en QA (CF-CATEGORÍAS-2D): normalizedTitle.includes(key) hacía
// match de substring sin límite de palabra — "evangelion" (anime) contiene
// literalmente "evangelio" como prefijo, "artesanal" contiene "arte", etc.
// containsPhrase exige que la frase aparezca como palabra(s) completas,
// delimitada por espacios o los bordes del texto (normalizeText ya deja
// solo letras/dígitos separados por un único espacio).
function containsPhrase(normalizedText, normalizedPhrase) {
  if (!normalizedPhrase) return false;
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function signalWordSetMatch(normalizedField, normalizedSignal) {
  const fieldWords = normalizedField.split(' ').filter(w => w.length >= 3);
  const signalWords = [...new Set(normalizedSignal.split(' ').filter(w => w.length >= 3))];
  if (fieldWords.length === 0 || signalWords.length === 0) return false;
  // La señal conocida debe estar contenida en el campo real, no al revés.
  // Antes "José Rodríguez" coincidía con la señal mucho más específica
  // "José María Rodríguez Olaizola" y enviaba libros de psicomotricidad a
  // Religión. Se permiten extras en el campo (segundos nombres, coautores),
  // pero nunca se acepta un campo incompleto como sustituto de la señal.
  if (signalWords.length === 1 && fieldWords.length > 1) return false;
  const fieldSet = new Set(fieldWords);
  return signalWords.every(w => fieldSet.has(w));
}

function findAuthorMatch(normalizedAuthor) {
  if (!normalizedAuthor) return null;
  for (const [key, categoryId] of AUTHOR_INDEX) {
    if (signalWordSetMatch(normalizedAuthor, key)) {
      return { categoryId, evidence: `autor coincide con lista conocida: "${key}"` };
    }
  }
  return null;
}

function findPublisherMatch(normalizedPublisher) {
  if (!normalizedPublisher) return null;
  for (const [key, categoryId] of PUBLISHER_INDEX) {
    if (signalWordSetMatch(normalizedPublisher, key)) {
      return { categoryId, evidence: `editorial coincide con lista conocida: "${key}"` };
    }
  }
  return null;
}

// Devuelve TODAS las coincidencias (no solo la primera) para poder llenar
// secondaryCategoryIds cuando un título toca más de un tema real.
function findKeywordMatches(normalizedTitle, table) {
  const matches = [];
  const seenCategories = new Set();
  for (const categoryId of Object.keys(table)) {
    for (const { phrase, subcategoryId } of table[categoryId]) {
      const key = normalizeText(phrase);
      if (key && containsPhrase(normalizedTitle, key)) {
        if (!seenCategories.has(categoryId)) {
          matches.push({ categoryId, subcategoryId, evidence: `título contiene frase distintiva: "${phrase}"` });
          seenCategories.add(categoryId);
        }
        break; // una coincidencia por categoría alcanza — no acumular ruido
      }
    }
  }
  return matches;
}

const OBJECT_FORMAT_TOKENS = ['cd', 'lp', 'dvd'];
// Encontrado en la revisión de calidad (CF-CATEGORÍAS-2C punto 8): libros de
// inglés con CD de audio incluido ("Workbook... Cd", "Student's Book +CD")
// se estaban clasificando como música por la palabra suelta "cd". Si el
// título ya tiene contexto claro de libro de idiomas, la palabra de formato
// sola no alcanza para decidir "es un disco".
const BOOK_WITH_AUDIO_CONTEXT = ['workbook', 'student', 'activity book', 'practice', 'course book', 'coursebook'];

function findObjectTypeSignal(normalizedTitle) {
  for (const { phrase, type, subcategoryId } of OBJECT_TYPE_SIGNALS) {
    const key = normalizeText(phrase);
    if (key && containsPhrase(normalizedTitle, key)) {
      return { type, subcategoryId, evidence: `título contiene señal de "${type}": "${phrase}"` };
    }
  }
  const words = normalizedTitle.split(' ');
  const looksLikeBookWithAudio = BOOK_WITH_AUDIO_CONTEXT.some(p => containsPhrase(normalizedTitle, normalizeText(p)));
  if (!looksLikeBookWithAudio) {
    for (const token of OBJECT_FORMAT_TOKENS) {
      if (words.includes(token)) {
        return { type: TYPES.MUSIC, subcategoryId: 'discos-vinilos', evidence: `palabra exacta de formato: "${token}"` };
      }
    }
  }
  return null;
}

function findGenericObjectSignal(normalizedTitle) {
  for (const phrase of OBJECT_SIGNALS) {
    const key = normalizeText(phrase);
    if (key && containsPhrase(normalizedTitle, key)) return phrase;
  }
  return null;
}

/**
 * @param {{mlu:string, title:string, author?:string, publisher?:string, isbn?:string, status:string}} record
 * @param {object|null} manualCorrection {type, primaryCategoryId, subcategoryId, secondaryCategoryIds, tags, note}
 */
export function classify(record, manualCorrection = null) {
  const base = {
    mlu: record.mlu,
    taxonomyVersion: TAXONOMY_VERSION,
    rulesVersion: RULES_VERSION,
  };

  if (manualCorrection) {
    return {
      ...base,
      type: manualCorrection.type,
      primaryCategoryId: manualCorrection.primaryCategoryId,
      subcategoryId: manualCorrection.subcategoryId ?? null,
      secondaryCategoryIds: manualCorrection.secondaryCategoryIds ?? [],
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
  const authorTag = record.author ? String(record.author).trim() : null;

  function withTags(extra = []) {
    const tags = [...extra];
    if (authorTag) tags.push(authorTag);
    return tags;
  }

  // 1. Tipo no-libro con subcategoría específica (música/revista/objeto) —
  // gana siempre que aparezca, independientemente de autor/editorial: un CD
  // con un autor de renombre en la tapa sigue siendo un CD, no un libro.
  const typedObject = findObjectTypeSignal(normalizedTitle);
  if (typedObject) {
    return {
      ...base,
      type: typedObject.type,
      primaryCategoryId: 'otros-productos',
      subcategoryId: typedObject.subcategoryId,
      secondaryCategoryIds: [],
      tags: withTags(),
      confidence: CONFIDENCE.OBJECT_TYPED,
      method: 'rule',
      evidence: [typedObject.evidence],
      needsReview: false,
    };
  }

  const authorMatch = findAuthorMatch(normalizedAuthor);
  const publisherMatch = findPublisherMatch(normalizedPublisher);
  const genericObjectSignal = findGenericObjectSignal(normalizedTitle);

  // 2. Objeto de colección genérico (antigüedad/decoración) — solo si no hay
  // autor/editorial de libro real reconocido contradiciéndolo.
  if (genericObjectSignal && !authorMatch && !publisherMatch) {
    if (!hasAuthor || !hasIsbn) {
      return {
        ...base,
        type: TYPES.OBJECT,
        primaryCategoryId: 'otros-productos',
        subcategoryId: 'objetos-coleccion',
        secondaryCategoryIds: [],
        tags: withTags(),
        confidence: CONFIDENCE.OBJECT,
        method: 'rule',
        evidence: [`título contiene señal de objeto: "${genericObjectSignal}"`, !hasAuthor ? 'sin autor' : 'sin ISBN'],
        needsReview: false,
      };
    }
    // Tiene autor e ISBN pese a la señal — probablemente SÍ es un libro
    // (ej. "Historia del candelabro..."), pero queda marcado para revisión
    // en vez de asumir con confianza.
  }

  if (authorMatch) {
    const keywordMatches = findKeywordMatches(normalizedTitle, KEYWORD_SIGNALS);
    const sameCategoryKeyword = keywordMatches.find(m => m.categoryId === authorMatch.categoryId);
    const keywordMatchesForSecondary = keywordMatches
      .filter(m => m.categoryId !== authorMatch.categoryId)
      .map(m => m.categoryId);
    return {
      ...base,
      type: TYPES.BOOK,
      primaryCategoryId: authorMatch.categoryId,
      subcategoryId: sameCategoryKeyword?.subcategoryId ?? null,
      secondaryCategoryIds: keywordMatchesForSecondary,
      tags: withTags(),
      confidence: CONFIDENCE.AUTHOR,
      method: 'rule',
      evidence: [
        authorMatch.evidence,
        ...(sameCategoryKeyword ? [sameCategoryKeyword.evidence] : []),
      ],
      needsReview: false,
    };
  }

  if (publisherMatch) {
    const sameCategoryKeyword = findKeywordMatches(normalizedTitle, KEYWORD_SIGNALS)
      .find(m => m.categoryId === publisherMatch.categoryId);
    return {
      ...base,
      type: TYPES.BOOK,
      primaryCategoryId: publisherMatch.categoryId,
      subcategoryId: sameCategoryKeyword?.subcategoryId ?? null,
      secondaryCategoryIds: [],
      tags: withTags(),
      confidence: CONFIDENCE.PUBLISHER,
      method: 'rule',
      evidence: [
        publisherMatch.evidence,
        ...(sameCategoryKeyword ? [sameCategoryKeyword.evidence] : []),
      ],
      needsReview: false,
    };
  }

  const keywordMatches = findKeywordMatches(normalizedTitle, KEYWORD_SIGNALS);
  if (keywordMatches.length > 0) {
    const [primary, ...rest] = keywordMatches;
    return {
      ...base,
      type: TYPES.BOOK,
      primaryCategoryId: primary.categoryId,
      subcategoryId: primary.subcategoryId,
      secondaryCategoryIds: rest.map(m => m.categoryId),
      tags: withTags(),
      confidence: CONFIDENCE.KEYWORD,
      method: 'rule',
      evidence: [primary.evidence],
      needsReview: false,
    };
  }

  const weakMatches = findKeywordMatches(normalizedTitle, KEYWORD_SIGNALS_WEAK);
  if (weakMatches.length > 0) {
    const [primary, ...rest] = weakMatches;
    return {
      ...base,
      type: TYPES.BOOK,
      primaryCategoryId: primary.categoryId,
      subcategoryId: primary.subcategoryId,
      secondaryCategoryIds: rest.map(m => m.categoryId),
      tags: withTags(),
      confidence: CONFIDENCE.KEYWORD_WEAK,
      method: 'rule',
      evidence: [primary.evidence],
      needsReview: true,
    };
  }

  if (genericObjectSignal) {
    // Señal de objeto + autor/ISBN presentes (caso dudoso de más arriba):
    // queda como libro en otros-libros, marcado para revisión, en vez de
    // objeto — preferimos el falso-book (visible, corregible) al
    // falso-object (también visible, pero categoría comercial equivocada).
    return {
      ...base,
      type: TYPES.BOOK,
      primaryCategoryId: 'otros-libros',
      subcategoryId: null,
      secondaryCategoryIds: [],
      tags: withTags(),
      confidence: CONFIDENCE.OBJECT_AMBIGUOUS,
      method: 'rule',
      evidence: [`señal de objeto "${genericObjectSignal}" pero con autor/ISBN — se prioriza como libro sin categoría clara`],
      needsReview: true,
    };
  }

  // Último recurso — CF-CATEGORÍAS-2C: nunca se excluye un activo del
  // catálogo público. Con evidencia razonable de ser un libro real
  // (autor o ISBN), "otros-libros"; si no hay ninguna evidencia de
  // materia ni de que sea un libro, "otros-productos" (nunca null).
  if (hasAuthor || hasIsbn) {
    return {
      ...base,
      type: TYPES.BOOK,
      primaryCategoryId: 'otros-libros',
      subcategoryId: null,
      secondaryCategoryIds: [],
      tags: withTags(),
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
    type: TYPES.OTHER,
    primaryCategoryId: 'otros-productos',
    subcategoryId: null,
    secondaryCategoryIds: [],
    tags: withTags(),
    confidence: CONFIDENCE.OTHER_PRODUCTS,
    method: 'rule',
    evidence: ['sin autor, sin ISBN, sin coincidencia de materia — no hay evidencia de que sea un libro'],
    needsReview: true,
  };
}

export function validateClassification(result) {
  const errors = [];
  if (!isValidCategoryId(result.primaryCategoryId)) {
    errors.push(`primaryCategoryId inválido: ${result.primaryCategoryId}`);
  }
  if (!isValidSubcategoryId(result.primaryCategoryId, result.subcategoryId)) {
    errors.push(`subcategoryId "${result.subcategoryId}" no pertenece a "${result.primaryCategoryId}"`);
  }
  for (const secId of result.secondaryCategoryIds || []) {
    if (!isValidCategoryId(secId)) errors.push(`secondaryCategoryId inválido: ${secId}`);
  }
  if (result.primaryCategoryId === null) {
    errors.push('primaryCategoryId nunca debe ser null — todo activo debe quedar visible en alguna categoría');
  }
  return errors;
}
