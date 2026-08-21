/**
 * functions/_shared/tarot-finder-scoring.js
 *
 * TAROT-FINDER-1: filtrado (hard constraints) y scoring (soft preferences)
 * puros para el selector "Encontrá tu mazo". Ninguna función acá hace
 * fetch ni toca el DOM — se ejecutan igual en el servidor (para
 * pre-validar) y en el cliente (dentro de tarot-finder.js).
 *
 * buildNoResultsWhatsAppMessage() reutiliza buildWhatsAppMessage()/
 * whatsappHref() de shared/whatsapp-messages.js — el número y la URL de
 * wa.me nunca se reconstruyen a mano acá.
 *
 * HARD vs SOFT (no negociable):
 *   HARD  -> activo+stock+precio ya vienen filtrados por
 *            buildTarotFinderDataset(); acá se agregan: primary_type
 *            cuando el usuario eligió sistema, deck_family cuando eligió
 *            tradición, language cuando exige idioma, bundle=mazo_mas_guia
 *            cuando exige guía. Una restricción hard nunca se relaja: un
 *            candidato que no la cumple queda afuera del resultado, punto.
 *   SOFT  -> primer mazo / estudiar / regalo / coleccionista / experiencia
 *            sólo suman puntos cuando el dato del candidato lo confirma.
 *            Nunca excluyen a nadie.
 *
 * 'desconocido' en el candidato NUNCA satisface una restricción hard
 * concreta (idioma, guía, familia) — es justamente lo que las pruebas
 * "unknown no satisface X" verifican.
 */

export const SCORE_WEIGHTS = Object.freeze({
  PRINCIPIANTE_PARA_PRIMER_MAZO: 30,
  GUIA_PARA_ESTUDIAR: 20,
  EDICION_ESPECIAL_PARA_REGALO_O_COLECCIONISTA: 10,
  // Extensión propia, no pedida explícitamente pero simétrica a la de
  // "primer mazo": recompensa level=avanzado_profesional cuando el usuario
  // dice que ya tiene experiencia. Mismo criterio "sólo si el dato lo
  // confirma" — con level='desconocido' (el caso más común) no suma nada.
  AVANZADO_PARA_EXPERIENCIA: 15,
  // Coincidencia secundaria demostrable: el mazo trae guía aunque el
  // usuario no la haya pedido como obligatoria.
  GUIA_NO_EXIGIDA_PERO_PRESENTE: 5,
});

const DECK_FAMILY_LABEL = Object.freeze({
  rider_waite_smith: 'Rider-Waite-Smith',
  marsella: 'Tarot de Marsella',
  thoth: 'Thoth',
});
const SYSTEM_LABEL = Object.freeze({
  tarot: 'Tarot',
  oraculo: 'Oráculo',
  lenormand: 'Lenormand',
  kipper: 'Kipper',
});
const LANGUAGE_LABEL = Object.freeze({
  espanol: 'Español',
  ingles: 'Inglés',
  multilingue: 'Multilingüe',
});
export const INTENT_LABEL = Object.freeze({
  primer_mazo: 'primer mazo',
  estudiar: 'aprender/estudiar',
  experiencia: 'ya tiene experiencia',
  regalo: 'regalo',
  coleccionista: 'coleccionista',
  sin_preferencia: null,
});

/**
 * Arma el texto para "no encontramos coincidencia exacta -> pedilo por
 * encargo", con las respuestas REALES del usuario, nunca inventadas. Sólo
 * incluye una línea por pregunta que el usuario efectivamente respondió con
 * una preferencia concreta (no_preference/unsure/sin_preferencia se omiten,
 * igual que en explainMatch).
 */
export function buildFinderNoResultsMessage(answers = {}, { buildWhatsAppMessage, page } = {}) {
  if (typeof buildWhatsAppMessage !== 'function') {
    throw new Error('buildFinderNoResultsMessage requiere buildWhatsAppMessage (shared/whatsapp-messages.js).');
  }
  const situationLines = [
    hasPreference(answers.system) ? `Tipo: ${SYSTEM_LABEL[answers.system] || answers.system}` : null,
    hasPreference(answers.deckFamily) ? `Tradición: ${DECK_FAMILY_LABEL[answers.deckFamily] || answers.deckFamily}` : null,
    hasPreference(answers.language) ? `Idioma: ${LANGUAGE_LABEL[answers.language] || answers.language}` : null,
    answers.guide === 'si' ? 'Guía: sí' : null,
    (answers.intent && INTENT_LABEL[answers.intent]) ? `Experiencia: ${INTENT_LABEL[answers.intent]}` : null,
  ].filter(Boolean);

  return buildWhatsAppMessage({
    greeting: 'Hola, estoy buscando un mazo en Amado Libros 😊',
    motive: 'Buscar un mazo con el selector "Encontrá tu mazo"',
    situation: situationLines.length ? situationLines.join('\n') : null,
    page,
    closing: 'No encontré una coincidencia exacta disponible. ¿Pueden buscarme opciones?',
  });
}

function hasPreference(value) {
  return Boolean(value) && value !== 'no_preference' && value !== 'unsure' && value !== 'sin_preferencia';
}

/**
 * true si el candidato cumple TODAS las restricciones hard de answers.
 * Nunca relaja silenciosamente: cada gate es una comparación exacta.
 */
export function passesHardConstraints(candidate, answers = {}) {
  if (!candidate) return false;
  if (hasPreference(answers.system) && candidate.primary_type !== answers.system) return false;
  if (hasPreference(answers.deckFamily) && candidate.deck_family !== answers.deckFamily) return false;
  if (hasPreference(answers.language) && candidate.language !== answers.language) return false;
  if (answers.guide === 'si' && candidate.bundle !== 'mazo_mas_guia') return false;
  return true;
}

/**
 * Puntaje de preferencias blandas — SOLO se llama sobre candidatos que ya
 * pasaron passesHardConstraints(); es segura de llamar sobre cualquier
 * candidato de todos modos (no lanza, no filtra).
 */
export function scoreTarotFinderCandidate(candidate, answers = {}) {
  let score = 0;
  const reasons = [];
  if (!candidate) return { score: 0, reasons };

  if (answers.intent === 'primer_mazo' && candidate.level === 'principiante') {
    score += SCORE_WEIGHTS.PRINCIPIANTE_PARA_PRIMER_MAZO;
    reasons.push('principiante');
  }
  if (answers.intent === 'estudiar' && candidate.bundle === 'mazo_mas_guia') {
    score += SCORE_WEIGHTS.GUIA_PARA_ESTUDIAR;
    reasons.push('guia_para_estudiar');
  }
  if ((answers.intent === 'regalo' || answers.intent === 'coleccionista') && candidate.edition_style === 'ilustrada_especial') {
    score += SCORE_WEIGHTS.EDICION_ESPECIAL_PARA_REGALO_O_COLECCIONISTA;
    reasons.push('edicion_especial');
  }
  if (answers.intent === 'experiencia' && candidate.level === 'avanzado_profesional') {
    score += SCORE_WEIGHTS.AVANZADO_PARA_EXPERIENCIA;
    reasons.push('avanzado');
  }
  if (answers.guide !== 'si' && candidate.bundle === 'mazo_mas_guia') {
    score += SCORE_WEIGHTS.GUIA_NO_EXIGIDA_PERO_PRESENTE;
    reasons.push('guia_bonus');
  }
  return { score, reasons };
}

/**
 * Filtra por hard constraints, puntúa, ordena y recorta.
 * Desempate documentado y estable: score DESC -> stock DESC -> price ASC ->
 * id ASC. Nunca aleatorio, nunca depende del orden de entrada.
 */
export function rankTarotFinderCandidates(candidates, answers = {}, { limit = 6 } = {}) {
  if (!Array.isArray(candidates)) throw new Error('candidates debe ser un array.');
  const passing = candidates.filter(c => passesHardConstraints(c, answers));
  const scored = passing.map(candidate => {
    const { score, reasons } = scoreTarotFinderCandidate(candidate, answers);
    return { candidate, score, reasons };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const stockDiff = (Number(b.candidate.stock) || 0) - (Number(a.candidate.stock) || 0);
    if (stockDiff !== 0) return stockDiff;
    const priceDiff = (Number(a.candidate.price) || 0) - (Number(b.candidate.price) || 0);
    if (priceDiff !== 0) return priceDiff;
    return String(a.candidate.id).localeCompare(String(b.candidate.id));
  });
  return scored.slice(0, Math.max(0, limit));
}

/**
 * Texto "por qué coincide" — sólo menciona atributos confirmados
 * (nunca 'desconocido'/null) y sólo los relevantes a lo que se preguntó.
 */
export function explainMatch(candidate, answers = {}) {
  const badges = [];
  if (DECK_FAMILY_LABEL[candidate.deck_family]) badges.push(DECK_FAMILY_LABEL[candidate.deck_family]);
  if (LANGUAGE_LABEL[candidate.language]) badges.push(LANGUAGE_LABEL[candidate.language]);
  if (candidate.bundle === 'mazo_mas_guia') badges.push('Incluye guía');
  if (candidate.edition_style === 'ilustrada_especial') badges.push('Edición especial');

  const systemLabel = SYSTEM_LABEL[candidate.primary_type] || null;
  const clauses = [];
  if (systemLabel) {
    clauses.push(hasPreference(answers.system) ? `buscás un ${systemLabel}` : `es un ${systemLabel}`);
  }
  if (hasPreference(answers.deckFamily) && DECK_FAMILY_LABEL[candidate.deck_family]) {
    clauses.push(DECK_FAMILY_LABEL[candidate.deck_family]);
  }
  if (hasPreference(answers.language) && LANGUAGE_LABEL[candidate.language]) {
    clauses.push(`en ${LANGUAGE_LABEL[candidate.language].toLowerCase()}`);
  }
  if (answers.guide === 'si' && candidate.bundle === 'mazo_mas_guia') {
    clauses.push('con guía');
  }
  const sentence = clauses.length ? `Coincide porque ${clauses.join(' ')}.` : '';
  return { badges, sentence };
}
