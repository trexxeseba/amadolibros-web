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
 * TAROT-FINDER-UX-2 (fix post-Preview): apertura del selector — 6 opciones,
 * cada una mapeada a una señal REAL que ya existe en el motor de scoring de
 * arriba. La versión anterior tenía 4 botones "reflexivos" (mirar hacia
 * adelante/claridad/decisión/entender una situación) que todos caían en
 * sin_preferencia y por lo tanto producían el MISMO ranking — cinco
 * promesas de personalización distintas sin ninguna evidencia de catálogo
 * detrás. Eso es falsa personalización, el mismo problema de fondo que el
 * lenguaje predictivo: prometer algo que el sistema no puede distinguir.
 * Ahora cada opción es una intención de compra real y afecta el ranking de
 * verdad. "Quiero aprender Tarot" además fija `system: 'tarot'` — es
 * exactamente lo que ese botón promete, no tendría sentido dejarlo abierto.
 */
export const OPENING_OPTIONS = Object.freeze([
  { value: 'primer_mazo', label: 'Es mi primer mazo', intent: 'primer_mazo' },
  { value: 'aprender_tarot', label: 'Quiero aprender Tarot', intent: 'estudiar', system: 'tarot' },
  { value: 'experiencia', label: 'Ya tengo experiencia', intent: 'experiencia' },
  { value: 'regalo', label: 'Busco un regalo', intent: 'regalo' },
  { value: 'coleccionista', label: 'Colecciono mazos', intent: 'coleccionista' },
  { value: 'explorar', label: 'Quiero explorar', intent: 'sin_preferencia' },
]);

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

// ---------------------------------------------------------------------------
// TAROT-FINDER-UX-2: alternativas cercanas cuando los filtros avanzados dan
// 0 resultados exactos. Nunca relaja una restricción hard en silencio — al
// contrario, expone EXACTAMENTE cuál no se cumple, para que la persona
// decida con información real. `pool` puede incluir candidatos con
// status:'paused' (lo podemos buscar por encargo, sin precio/stock prometidos,
// mismo criterio que GW2): un candidato pausado que SÍ cumple todo es la
// mejor alternativa posible — un match real, sólo que no está en stock hoy.
// ---------------------------------------------------------------------------

/**
 * `system` NUNCA se relaja para una alternativa — sugerir un Oráculo cuando
 * la persona pidió Tarot (o un Tarot cuando pidió Lenormand) no es "una
 * alternativa cercana", es ofrecer otra cosa. Tradición/idioma/guía sí
 * pueden flexibilizarse explícitamente: son las restricciones "blandas" de
 * la alternativa (no del ranking principal, que sigue siendo 100% hard).
 */
function systemMatches(candidate, answers) {
  return hasPreference(answers.system) ? candidate.primary_type === answers.system : true;
}

function softConstraintChecks(candidate, answers = {}) {
  const checks = [];
  if (hasPreference(answers.deckFamily)) {
    checks.push({ key: 'deckFamily', met: candidate.deck_family === answers.deckFamily });
  }
  if (hasPreference(answers.language)) {
    checks.push({ key: 'language', met: candidate.language === answers.language });
  }
  if (answers.guide === 'si') {
    checks.push({ key: 'guide', met: candidate.bundle === 'mazo_mas_guia' });
  }
  return checks;
}

/**
 * Qué restricciones (incluido system) cumple un candidato — sólo para
 * armar la frase explicativa (explainNearMiss); la decisión de qué entra
 * como alternativa vive en findNearestTarotAlternatives.
 */
function hardConstraintChecks(candidate, answers = {}) {
  const checks = [];
  if (hasPreference(answers.system)) {
    checks.push({ key: 'system', met: candidate.primary_type === answers.system });
  }
  return [...checks, ...softConstraintChecks(candidate, answers)];
}

/**
 * Candidatos que NO cumplen el 100% de las restricciones activas, pero
 * están lo más cerca posible — se llama sólo cuando rankTarotFinderCandidates
 * ya dio 0 resultados exactos con al menos una restricción activa.
 *
 * Reglas (no negociables):
 *  1. `system`, si la persona lo eligió, NUNCA se relaja — un candidato que
 *     no lo cumple queda afuera del todo, no es "casi" una alternativa.
 *  2. Tradición/idioma/guía sí pueden flexibilizarse, pero debe cumplir AL
 *     MENOS UNA de las que estén activas — violar TODAS las restricciones
 *     blandas también descarta al candidato (ver `un libro cualquiera` más
 *     abajo). Si `system` era la única restricción activa, alcanza con
 *     cumplirla: ya es la alternativa más cercana posible por definición.
 *  3. Orden: primero cualquier candidato "pausado" que cumple TODO (match
 *     real, lo podemos buscar por encargo); después, por cantidad de
 *     restricciones blandas violadas ascendente; desempate igual que
 *     rankTarotFinderCandidates (score de preferencias, luego
 *     stock/precio/id).
 *  4. Si no queda ningún candidato admisible, devuelve [] — el llamador
 *     debe ofrecer sólo el camino de WhatsApp, nunca inventar una
 *     alternativa que no lo es.
 */
export function findNearestTarotAlternatives(pool, answers = {}, { limit = 3 } = {}) {
  if (!Array.isArray(pool)) throw new Error('pool debe ser un array.');
  const anyConstraintActive = hasPreference(answers.system) || hasPreference(answers.deckFamily) ||
    hasPreference(answers.language) || answers.guide === 'si';
  if (!anyConstraintActive) return [];

  const checked = pool
    .map(candidate => {
      const softChecks = softConstraintChecks(candidate, answers);
      const violations = softChecks.filter(c => !c.met).map(c => c.key);
      const { score } = scoreTarotFinderCandidate(candidate, answers);
      return { candidate, systemOk: systemMatches(candidate, answers), softChecks, violations, score };
    })
    .filter(entry => {
      if (!entry.systemOk) return false;
      // Sin restricciones blandas activas, cumplir `system` (si estaba
      // activo) ya es la alternativa más cercana posible.
      if (entry.softChecks.length === 0) return true;
      // Debe compartir al menos una restricción blanda real con lo pedido
      // — violar TODAS no es "cercano", es un mazo cualquiera del mismo
      // sistema.
      return entry.violations.length < entry.softChecks.length;
    });

  checked.sort((a, b) => {
    const aExactPaused = a.violations.length === 0 && a.candidate.status === 'paused' ? 0 : 1;
    const bExactPaused = b.violations.length === 0 && b.candidate.status === 'paused' ? 0 : 1;
    if (aExactPaused !== bExactPaused) return aExactPaused - bExactPaused;
    if (a.violations.length !== b.violations.length) return a.violations.length - b.violations.length;
    if (b.score !== a.score) return b.score - a.score;
    const stockDiff = (Number(b.candidate.stock) || 0) - (Number(a.candidate.stock) || 0);
    if (stockDiff !== 0) return stockDiff;
    const priceDiff = (Number(a.candidate.price) || 0) - (Number(b.candidate.price) || 0);
    if (priceDiff !== 0) return priceDiff;
    return String(a.candidate.id).localeCompare(String(b.candidate.id));
  });

  return checked.slice(0, Math.max(0, limit)).map(({ candidate, violations }) => ({ candidate, violations }));
}

const HARD_CONSTRAINT_MET_CLAUSE = {
  system: (candidate) => SYSTEM_LABEL[candidate.primary_type] ? `es ${SYSTEM_LABEL[candidate.primary_type]}` : null,
  deckFamily: (candidate) => DECK_FAMILY_LABEL[candidate.deck_family] ? `es ${DECK_FAMILY_LABEL[candidate.deck_family]}` : null,
  language: (candidate) => LANGUAGE_LABEL[candidate.language] ? `está en ${LANGUAGE_LABEL[candidate.language]}` : null,
  guide: (candidate) => candidate.bundle === 'mazo_mas_guia' ? 'incluye guía' : null,
};
const HARD_CONSTRAINT_UNMET_CLAUSE = {
  system: (answers) => `no es ${SYSTEM_LABEL[answers.system] || answers.system}`,
  deckFamily: (answers) => `no es ${DECK_FAMILY_LABEL[answers.deckFamily] || answers.deckFamily}`,
  language: (answers) => `no está en ${LANGUAGE_LABEL[answers.language] || answers.language}`,
  guide: () => 'no incluye guía',
};

/**
 * Frase objetiva "qué cumple / qué no" para una alternativa cercana —
 * mismo estilo que los ejemplos pedidos: "Está en español y es
 * Rider-Waite-Smith, pero no incluye guía." Si el candidato es pausado y
 * cumple todo, la frase es sobre disponibilidad, no sobre una restricción
 * violada: "Cumple [lo pedido], lo podemos buscar por encargo." — nunca
 * "disponible por encargo": pausado no es disponibilidad confirmada.
 */
export function explainNearMiss(candidate, answers = {}, violations = []) {
  const checks = hardConstraintChecks(candidate, answers);
  const metKeys = checks.filter(c => c.met).map(c => c.key);
  const metClauses = metKeys.map(key => HARD_CONSTRAINT_MET_CLAUSE[key]?.(candidate)).filter(Boolean);

  if (violations.length === 0 && candidate.status === 'paused') {
    const summary = metClauses.length ? `Cumple ${metClauses.join(', ')}` : 'Cumple lo que buscás';
    return `${summary}, lo podemos buscar por encargo.`;
  }

  const unmetClauses = violations.map(key => HARD_CONSTRAINT_UNMET_CLAUSE[key]?.(answers)).filter(Boolean);
  const metText = metClauses.length ? metClauses.join(' y ') : null;
  const unmetText = unmetClauses.length ? unmetClauses.join(', ') : null;
  if (metText && unmetText) return `${capitalize(metText)}, pero ${unmetText}.`;
  if (unmetText) return `${capitalize(unmetText)}.`;
  if (metText) return `${capitalize(metText)}.`;
  return '';
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
