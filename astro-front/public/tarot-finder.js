(function () {
  'use strict';
  if (window.AmadoTarotFinder) return;
  window.AmadoTarotFinder = true;

  // Espejo en vanilla JS de functions/_shared/tarot-finder-scoring.js — la
  // lógica canónica y testeada (node --test) vive ahí; acá se reimplementa
  // porque el navegador no puede importar ese módulo ES sin bundler. Si se
  // cambia un peso o una regla hard/soft, hay que cambiarla en los DOS
  // lugares. Mismos nombres de campos, mismo orden de desempate.
  //
  // TAROT-FINDER-UX-2: máquina de estados de "recomendador progresivo" —
  // apertura (7 intenciones) -> resultados inmediatos -> "Afinar mi
  // búsqueda" (filtros avanzados, opcional) -> si 0 exactos, alternativas
  // cercanas explícitas. Todas las funciones puras de acá abajo (sin DOM)
  // se exponen también en window.__AmadoTarotFinderTestHooks, exclusivamente
  // para que functions/__tests__/tarot-finder-client.test.js pueda ejecutar
  // ESTE archivo real dentro de un harness de Node y comparar sus
  // resultados byte a byte contra tarot-finder-scoring.js — no es una API
  // pública, no se usa desde el propio flujo de la UI.
  var REFINE_ORDER = ['system', 'family', 'language', 'guide'];
  var MAX_RESULTS = 6;
  var MAX_ALTERNATIVES = 3;
  var SCORE = {
    PRINCIPIANTE_PARA_PRIMER_MAZO: 30,
    GUIA_PARA_ESTUDIAR: 20,
    EDICION_ESPECIAL_PARA_REGALO_O_COLECCIONISTA: 10,
    AVANZADO_PARA_EXPERIENCIA: 15,
    GUIA_NO_EXIGIDA_PERO_PRESENTE: 5,
  };

  var SYSTEM_LABEL = { tarot: 'Tarot', oraculo: 'Oráculo', lenormand: 'Lenormand', kipper: 'Kipper' };
  var DECK_FAMILY_LABEL = { rider_waite_smith: 'Rider-Waite-Smith', marsella: 'Tarot de Marsella', thoth: 'Thoth' };
  var LANGUAGE_LABEL = { espanol: 'Español', ingles: 'Inglés', multilingue: 'Multilingüe' };
  var INTENT_LABEL = { primer_mazo: 'primer mazo', estudiar: 'aprender/estudiar', experiencia: 'ya tiene experiencia', regalo: 'regalo', coleccionista: 'coleccionista' };

  // TAROT-FINDER-UX-2 (fix post-Preview): apertura del selector — 6
  // opciones, cada una mapeada a una señal REAL que ya existe en el motor
  // de scoring. La versión anterior tenía 4 botones "reflexivos" que todos
  // caían en sin_preferencia y producían el MISMO ranking — falsa
  // personalización. "Quiero aprender Tarot" además fija system:'tarot',
  // exactamente lo que ese botón promete.
  var OPENING_OPTIONS = [
    { value: 'primer_mazo', label: 'Es mi primer mazo', intent: 'primer_mazo' },
    { value: 'aprender_tarot', label: 'Quiero aprender Tarot', intent: 'estudiar', system: 'tarot' },
    { value: 'experiencia', label: 'Ya tengo experiencia', intent: 'experiencia' },
    { value: 'regalo', label: 'Busco un regalo', intent: 'regalo' },
    { value: 'coleccionista', label: 'Colecciono mazos', intent: 'coleccionista' },
    { value: 'explorar', label: 'Quiero explorar', intent: 'sin_preferencia' },
  ];

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hasPreference(v) {
    return Boolean(v) && v !== 'no_preference' && v !== 'unsure' && v !== 'sin_preferencia';
  }

  function passesHard(candidate, answers) {
    if (hasPreference(answers.system) && candidate.primary_type !== answers.system) return false;
    if (hasPreference(answers.deckFamily) && candidate.deck_family !== answers.deckFamily) return false;
    if (hasPreference(answers.language) && candidate.language !== answers.language) return false;
    if (answers.guide === 'si' && candidate.bundle !== 'mazo_mas_guia') return false;
    return true;
  }

  function scoreCandidate(candidate, answers) {
    var score = 0;
    if (answers.intent === 'primer_mazo' && candidate.level === 'principiante') score += SCORE.PRINCIPIANTE_PARA_PRIMER_MAZO;
    if (answers.intent === 'estudiar' && candidate.bundle === 'mazo_mas_guia') score += SCORE.GUIA_PARA_ESTUDIAR;
    if ((answers.intent === 'regalo' || answers.intent === 'coleccionista') && candidate.edition_style === 'ilustrada_especial') score += SCORE.EDICION_ESPECIAL_PARA_REGALO_O_COLECCIONISTA;
    if (answers.intent === 'experiencia' && candidate.level === 'avanzado_profesional') score += SCORE.AVANZADO_PARA_EXPERIENCIA;
    if (answers.guide !== 'si' && candidate.bundle === 'mazo_mas_guia') score += SCORE.GUIA_NO_EXIGIDA_PERO_PRESENTE;
    return score;
  }

  // Desempate documentado: score DESC -> stock DESC -> price ASC -> id ASC.
  function rankCandidates(dataset, answers) {
    var passing = dataset.filter(function (c) { return passesHard(c, answers); });
    var scored = passing.map(function (c) { return { candidate: c, score: scoreCandidate(c, answers) }; });
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var stockDiff = (Number(b.candidate.stock) || 0) - (Number(a.candidate.stock) || 0);
      if (stockDiff !== 0) return stockDiff;
      var priceDiff = (Number(a.candidate.price) || 0) - (Number(b.candidate.price) || 0);
      if (priceDiff !== 0) return priceDiff;
      return String(a.candidate.id).localeCompare(String(b.candidate.id));
    });
    return scored.slice(0, MAX_RESULTS);
  }

  function explainMatch(candidate, answers) {
    var badges = [];
    if (DECK_FAMILY_LABEL[candidate.deck_family]) badges.push(DECK_FAMILY_LABEL[candidate.deck_family]);
    if (LANGUAGE_LABEL[candidate.language]) badges.push(LANGUAGE_LABEL[candidate.language]);
    if (candidate.bundle === 'mazo_mas_guia') badges.push('Incluye guía');
    if (candidate.edition_style === 'ilustrada_especial') badges.push('Edición especial');

    var systemLabel = SYSTEM_LABEL[candidate.primary_type];
    var clauses = [];
    if (systemLabel) clauses.push(hasPreference(answers.system) ? ('buscás un ' + systemLabel) : ('es un ' + systemLabel));
    if (hasPreference(answers.deckFamily) && DECK_FAMILY_LABEL[candidate.deck_family]) clauses.push(DECK_FAMILY_LABEL[candidate.deck_family]);
    if (hasPreference(answers.language) && LANGUAGE_LABEL[candidate.language]) clauses.push('en ' + LANGUAGE_LABEL[candidate.language].toLowerCase());
    if (answers.guide === 'si' && candidate.bundle === 'mazo_mas_guia') clauses.push('con guía');
    return { badges: badges, sentence: clauses.length ? ('Coincide porque ' + clauses.join(' ') + '.') : '' };
  }

  function buildNoResultsMessage(answers, page) {
    var lines = ['Hola, estoy buscando un mazo en Amado Libros 😊', '', 'Motivo: Buscar un mazo con el selector "Encontrá tu mazo"'];
    var situation = [];
    if (hasPreference(answers.system)) situation.push('Tipo: ' + SYSTEM_LABEL[answers.system]);
    if (hasPreference(answers.deckFamily)) situation.push('Tradición: ' + DECK_FAMILY_LABEL[answers.deckFamily]);
    if (hasPreference(answers.language)) situation.push('Idioma: ' + LANGUAGE_LABEL[answers.language]);
    if (answers.guide === 'si') situation.push('Guía: sí');
    if (answers.intent && INTENT_LABEL[answers.intent]) situation.push('Experiencia: ' + INTENT_LABEL[answers.intent]);
    if (situation.length) lines.push('Situación: ' + situation.join('\n'));
    if (page) lines.push('Página: ' + page);
    lines.push('', 'No encontré una coincidencia exacta disponible. ¿Pueden buscarme opciones?');
    return lines.join('\n');
  }

  // ---- Alternativas cercanas (0 resultados exactos con filtros activos) --
  // `system` NUNCA se relaja para una alternativa — sugerir un Oráculo
  // cuando la persona pidió Tarot no es "una alternativa cercana". Sí puede
  // flexibilizarse tradición/idioma/guía, pero debe cumplir al menos una de
  // las que estén activas.

  function systemMatches(candidate, answers) {
    return hasPreference(answers.system) ? candidate.primary_type === answers.system : true;
  }

  function softConstraintChecks(candidate, answers) {
    var checks = [];
    if (hasPreference(answers.deckFamily)) checks.push({ key: 'deckFamily', met: candidate.deck_family === answers.deckFamily });
    if (hasPreference(answers.language)) checks.push({ key: 'language', met: candidate.language === answers.language });
    if (answers.guide === 'si') checks.push({ key: 'guide', met: candidate.bundle === 'mazo_mas_guia' });
    return checks;
  }

  function hardConstraintChecks(candidate, answers) {
    var checks = [];
    if (hasPreference(answers.system)) checks.push({ key: 'system', met: candidate.primary_type === answers.system });
    return checks.concat(softConstraintChecks(candidate, answers));
  }

  function findNearestAlternatives(pool, answers, limit) {
    limit = limit || MAX_ALTERNATIVES;
    var anyConstraintActive = hasPreference(answers.system) || hasPreference(answers.deckFamily) ||
      hasPreference(answers.language) || answers.guide === 'si';
    if (!anyConstraintActive) return [];

    var checked = [];
    for (var i = 0; i < pool.length; i++) {
      var candidate = pool[i];
      if (!systemMatches(candidate, answers)) continue;
      var softChecks = softConstraintChecks(candidate, answers);
      var violations = [];
      for (var j = 0; j < softChecks.length; j++) if (!softChecks[j].met) violations.push(softChecks[j].key);
      // Sin restricciones blandas activas, cumplir `system` ya alcanza.
      // Con restricciones blandas activas, hay que cumplir al menos una.
      if (softChecks.length > 0 && violations.length >= softChecks.length) continue;
      checked.push({ candidate: candidate, violations: violations, score: scoreCandidate(candidate, answers) });
    }
    checked.sort(function (a, b) {
      var aExactPaused = (a.violations.length === 0 && a.candidate.status === 'paused') ? 0 : 1;
      var bExactPaused = (b.violations.length === 0 && b.candidate.status === 'paused') ? 0 : 1;
      if (aExactPaused !== bExactPaused) return aExactPaused - bExactPaused;
      if (a.violations.length !== b.violations.length) return a.violations.length - b.violations.length;
      if (b.score !== a.score) return b.score - a.score;
      var stockDiff = (Number(b.candidate.stock) || 0) - (Number(a.candidate.stock) || 0);
      if (stockDiff !== 0) return stockDiff;
      var priceDiff = (Number(a.candidate.price) || 0) - (Number(b.candidate.price) || 0);
      if (priceDiff !== 0) return priceDiff;
      return String(a.candidate.id).localeCompare(String(b.candidate.id));
    });
    return checked.slice(0, Math.max(0, limit)).map(function (e) { return { candidate: e.candidate, violations: e.violations }; });
  }

  var MET_CLAUSE = {
    system: function (c) { return SYSTEM_LABEL[c.primary_type] ? ('es ' + SYSTEM_LABEL[c.primary_type]) : null; },
    deckFamily: function (c) { return DECK_FAMILY_LABEL[c.deck_family] ? ('es ' + DECK_FAMILY_LABEL[c.deck_family]) : null; },
    language: function (c) { return LANGUAGE_LABEL[c.language] ? ('está en ' + LANGUAGE_LABEL[c.language]) : null; },
    guide: function (c) { return c.bundle === 'mazo_mas_guia' ? 'incluye guía' : null; },
  };
  var UNMET_CLAUSE = {
    system: function (a) { return 'no es ' + (SYSTEM_LABEL[a.system] || a.system); },
    deckFamily: function (a) { return 'no es ' + (DECK_FAMILY_LABEL[a.deckFamily] || a.deckFamily); },
    language: function (a) { return 'no está en ' + (LANGUAGE_LABEL[a.language] || a.language); },
    guide: function () { return 'no incluye guía'; },
  };

  function capitalize(text) {
    return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
  }

  function explainNearMiss(candidate, answers, violations) {
    var checks = hardConstraintChecks(candidate, answers);
    var metClauses = [];
    for (var i = 0; i < checks.length; i++) {
      if (!checks[i].met) continue;
      var clause = MET_CLAUSE[checks[i].key] ? MET_CLAUSE[checks[i].key](candidate) : null;
      if (clause) metClauses.push(clause);
    }
    if (violations.length === 0 && candidate.status === 'paused') {
      var summary = metClauses.length ? ('Cumple ' + metClauses.join(', ')) : 'Cumple lo que buscás';
      return summary + ', lo podemos buscar por encargo.';
    }
    var unmetClauses = [];
    for (var k = 0; k < violations.length; k++) {
      var uc = UNMET_CLAUSE[violations[k]] ? UNMET_CLAUSE[violations[k]](answers) : null;
      if (uc) unmetClauses.push(uc);
    }
    var metText = metClauses.length ? metClauses.join(' y ') : null;
    var unmetText = unmetClauses.length ? unmetClauses.join(', ') : null;
    if (metText && unmetText) return capitalize(metText) + ', pero ' + unmetText + '.';
    if (unmetText) return capitalize(unmetText) + '.';
    if (metText) return capitalize(metText) + '.';
    return '';
  }

  // FIX 1 (post-Preview): un candidato pausado NUNCA tiene precio/stock
  // reales (ver buildTarotFinderDataset con status='paused') — mostrar
  // "$0 UYU" sería inventar un precio. En su lugar: badge/copy de encargo
  // y un CTA que invita a consultar, no a "ver" como si ya estuviera
  // disponible. Función pura (sin DOM) a propósito, igual que el resto de
  // este bloque — se expone en los test hooks para probarla directamente.
  function resultCardHtml(candidate, answers) {
    var ex = explainMatch(candidate, answers);
    var isPaused = candidate.status === 'paused';
    var priceOrEncargoHtml = isPaused
      ? '<p class="tf-result-encargo">Lo podemos buscar por encargo</p>'
      : '<p class="tf-result-price">$' + Number(candidate.price || 0).toLocaleString('es-UY') + ' UYU</p>';
    var ctaLabel = isPaused ? 'Consultar este mazo' : 'Ver mazo';
    return '<article class="tf-result-card' + (isPaused ? ' tf-result-card-paused' : '') + '">' +
      (candidate.image ? '<img src="' + escapeHtml(candidate.image) + '" alt="Portada de ' + escapeHtml(candidate.title) + '" loading="lazy" decoding="async">' : '') +
      '<div class="tf-result-body">' +
      (ex.badges.length ? '<div class="tf-result-badges">' + ex.badges.map(function (b) { return '<span>' + escapeHtml(b) + '</span>'; }).join('') + '</div>' : '') +
      '<h4>' + escapeHtml(candidate.title) + '</h4>' +
      (ex.sentence ? '<p class="tf-result-why">' + escapeHtml(ex.sentence) + '</p>' : '') +
      priceOrEncargoHtml +
      '<a class="tf-result-cta" href="' + escapeHtml(candidate.href) + '">' + ctaLabel + '</a>' +
      '</div></article>';
  }

  // ---- Máquina de estados (sin DOM) --------------------------------------
  // Extraída aparte de init() a propósito: son las funciones que
  // functions/__tests__/tarot-finder-client.test.js ejercita para probar el
  // flujo real, no sólo el HTML estático.

  function relevantSteps(answers) {
    return REFINE_ORDER.filter(function (s) { return s !== 'family' || answers.system === 'tarot'; });
  }

  function nextStepFrom(step, answers) {
    var order = relevantSteps(answers);
    var idx = order.indexOf(step);
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : 'results';
  }

  // "volver" desde 'results': si ya se entró a "Afinar mi búsqueda" vuelve a
  // la última pregunta aplicable del refinamiento; si no, vuelve a
  // 'opening'. Desde el primer paso del refinamiento ('system') vuelve a
  // 'results' (no cierra: 'results' es la base, no una pregunta más).
  function prevStepFrom(step, answers, refining) {
    var order = relevantSteps(answers);
    if (step === 'results') {
      return refining ? order[order.length - 1] : 'opening';
    }
    var idx = order.indexOf(step);
    if (idx > 0) return order[idx - 1];
    return 'results';
  }

  function initialFinderState() {
    return { step: 'opening', answers: {}, systemExplainerOpen: false, refining: false, alternativesRevealed: false };
  }

  /**
   * Reductor puro: (estado, campo, valor) -> nuevo estado. No muta el
   * estado recibido.
   *
   * field='opening': confirma una de las 7 intenciones de apertura -> fija
   * answers.intent (reutiliza el motor de scoring existente, nunca inventa
   * una señal nueva) y va DIRECTO a 'results' — nunca obliga a completar
   * sistema/tradición/idioma/guía antes.
   *
   * Dentro del refinamiento (system/family/language/guide): mismas reglas
   * que TAROT-FINDER-1 — "No estoy seguro/a" la primera vez en 'system'
   * sólo abre el explicador; cambiar `system` a algo que no sea 'tarot'
   * elimina `answers.deckFamily` de inmediato.
   */
  function applyChoice(state, field, value) {
    var answers = {};
    for (var k in state.answers) if (Object.prototype.hasOwnProperty.call(state.answers, k)) answers[k] = state.answers[k];

    if (field === 'opening') {
      var opt = null;
      for (var i = 0; i < OPENING_OPTIONS.length; i++) if (OPENING_OPTIONS[i].value === value) { opt = OPENING_OPTIONS[i]; break; }
      answers.intent = opt ? opt.intent : 'sin_preferencia';
      answers.openingChoice = value;
      // "Quiero aprender Tarot" fija system:'tarot' — es lo que ese botón
      // promete exactamente. Ninguna otra opción de apertura toca `system`.
      if (opt && opt.system) answers.system = opt.system;
      return { step: 'results', answers: answers, systemExplainerOpen: false, refining: state.refining, alternativesRevealed: false };
    }

    if (field === 'system' && value === 'unsure' && state.step === 'system' && !state.systemExplainerOpen) {
      return { step: 'system', answers: answers, systemExplainerOpen: true, refining: state.refining, alternativesRevealed: false };
    }

    if (field === 'system' && value !== 'tarot') {
      delete answers.deckFamily;
    }
    answers[field] = value;

    var nextState = { step: state.step, answers: answers, systemExplainerOpen: false, refining: state.refining, alternativesRevealed: false };
    nextState.step = nextStepFrom(state.step, answers);
    return nextState;
  }

  /** Entra (o vuelve a entrar) al refinamiento opcional desde 'results'. */
  function applyStartRefine(state) {
    var order = relevantSteps(state.answers);
    return { step: order[0], answers: state.answers, systemExplainerOpen: false, refining: true, alternativesRevealed: false };
  }

  /** Revela las alternativas cercanas en la pantalla de 0 resultados exactos. */
  function applyRevealAlternatives(state) {
    return { step: state.step, answers: state.answers, systemExplainerOpen: false, refining: state.refining, alternativesRevealed: true };
  }

  /** "volver" desde el sub-estado del explicador de sistema vuelve a la
   * vista simple de la misma pregunta, nunca cierra. */
  function applyGoBack(state) {
    if (state.step === 'system' && state.systemExplainerOpen) {
      return { step: 'system', answers: state.answers, systemExplainerOpen: false, refining: state.refining, alternativesRevealed: false };
    }
    if (state.step === 'opening') return null; // señal: cerrar el Finder
    if (state.step === 'results' && state.alternativesRevealed) {
      return { step: 'results', answers: state.answers, systemExplainerOpen: false, refining: state.refining, alternativesRevealed: false };
    }
    var prev = prevStepFrom(state.step, state.answers, state.refining);
    return { step: prev, answers: state.answers, systemExplainerOpen: false, refining: state.refining, alternativesRevealed: false };
  }

  var QUESTIONS = {
    system: {
      field: 'system',
      title: '¿Qué tipo de cartas buscás?',
      options: [
        { value: 'tarot', label: 'Tarot' },
        { value: 'oraculo', label: 'Oráculo' },
        { value: 'lenormand', label: 'Lenormand' },
        { value: 'unsure', label: 'No estoy seguro/a' },
      ],
      explainerOptions: [
        { value: 'tarot', label: 'Tarot' },
        { value: 'oraculo', label: 'Oráculo' },
        { value: 'lenormand', label: 'Lenormand' },
        { value: 'unsure', label: 'Seguir sin preferencia' },
      ],
      explainer: [
        { title: 'Tarot', text: 'Sistema habitualmente estructurado en 78 cartas.' },
        { title: 'Oráculo', text: 'Cada mazo puede tener estructura y temática propias.' },
        { title: 'Lenormand', text: 'Sistema distinto del Tarot, tradicionalmente de 36 cartas.' },
      ],
    },
    family: {
      field: 'deckFamily',
      title: '¿Qué tradición de Tarot preferís?',
      options: [
        { value: 'rider_waite_smith', label: 'Rider-Waite-Smith' },
        { value: 'marsella', label: 'Tarot de Marsella' },
        { value: 'thoth', label: 'Thoth' },
        { value: 'no_preference', label: 'No tengo preferencia' },
      ],
    },
    language: {
      field: 'language',
      title: '¿Qué idioma preferís?',
      options: [
        { value: 'espanol', label: 'Español' },
        { value: 'ingles', label: 'Inglés' },
        { value: 'multilingue', label: 'Multilingüe' },
        { value: 'no_preference', label: 'Me da igual' },
      ],
    },
    guide: {
      field: 'guide',
      title: '¿Querés que venga con guía o libro?',
      options: [
        { value: 'si', label: 'Sí' },
        { value: 'no_importante', label: 'No es importante' },
      ],
    },
  };

  // Hooks de sólo-test (ver comentario de cabecera). No se llaman desde la
  // UI real; existen para que un harness de Node ejecute este archivo tal
  // cual se sirve y compare contra tarot-finder-scoring.js.
  window.__AmadoTarotFinderTestHooks = {
    REFINE_ORDER: REFINE_ORDER, MAX_RESULTS: MAX_RESULTS, MAX_ALTERNATIVES: MAX_ALTERNATIVES,
    SCORE: SCORE, QUESTIONS: QUESTIONS, OPENING_OPTIONS: OPENING_OPTIONS,
    hasPreference: hasPreference, passesHard: passesHard, scoreCandidate: scoreCandidate,
    rankCandidates: rankCandidates, explainMatch: explainMatch, buildNoResultsMessage: buildNoResultsMessage,
    findNearestAlternatives: findNearestAlternatives, explainNearMiss: explainNearMiss, resultCardHtml: resultCardHtml,
    relevantSteps: relevantSteps, nextStepFrom: nextStepFrom, prevStepFrom: prevStepFrom,
    initialFinderState: initialFinderState, applyChoice: applyChoice, applyGoBack: applyGoBack,
    applyStartRefine: applyStartRefine, applyRevealAlternatives: applyRevealAlternatives,
  };

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  ready(init);

  function init() {
    var section = document.getElementById('tarot-finder-cta');
    var root = document.getElementById('tarot-finder-app');
    var startBtn = document.getElementById('tarot-finder-start');
    var dataEl = document.getElementById('tarot-finder-dataset');
    var fallbackDataEl = document.getElementById('tarot-finder-fallback-dataset');
    if (!section || !root || !startBtn || !dataEl) return;

    var waBase = section.getAttribute('data-wa-base') || '';
    var pageUrl = window.location.href.split('#')[0].split('?')[0];

    var dataset;
    try { dataset = JSON.parse(dataEl.textContent || '[]'); } catch (_e) { dataset = []; }
    if (!Array.isArray(dataset) || dataset.length === 0) return;

    var fallbackDataset = [];
    if (fallbackDataEl) {
      try { fallbackDataset = JSON.parse(fallbackDataEl.textContent || '[]'); } catch (_e2) { fallbackDataset = []; }
      if (!Array.isArray(fallbackDataset)) fallbackDataset = [];
    }
    // El pool de alternativas incluye el propio dataset activo (por si un
    // candidato activo casi-exacto no llegó a pasar rankCandidates) más el
    // pool por encargo.
    var alternativesPool = dataset.concat(fallbackDataset);

    var state = null;

    startBtn.addEventListener('click', function () {
      state = initialFinderState();
      startBtn.hidden = true;
      root.hidden = false;
      render();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && state && !root.hidden) closeFinder();
    });

    function choose(field, value) {
      state = applyChoice(state, field, value);
      render();
    }

    function goBack() {
      var nextState = applyGoBack(state);
      if (nextState === null) { closeFinder(); return; }
      state = nextState;
      render();
    }

    function restart() {
      state = initialFinderState();
      render();
    }

    function startRefine() {
      state = applyStartRefine(state);
      render();
    }

    function revealAlternatives() {
      state = applyRevealAlternatives(state);
      render();
    }

    function closeFinder() {
      root.hidden = true;
      root.innerHTML = '';
      startBtn.hidden = false;
      startBtn.focus();
      state = null;
    }

    function stepPosition(step) {
      return relevantSteps(state.answers).indexOf(step) + 1;
    }
    function stepTotal() {
      return relevantSteps(state.answers).length;
    }

    function render() {
      if (!state) return;
      if (state.step === 'opening') renderOpening();
      else if (state.step === 'results') renderResults();
      else renderQuestion(state.step);
    }

    function renderOpening() {
      var html = '<div class="tf-opening">';
      html += '<h3 tabindex="-1" id="tf-heading">¿Qué mazo va con lo que estás buscando?</h3>';
      html += '<p class="tf-opening-sub">Contanos qué querés explorar hoy — claridad, una decisión, mirar hacia adelante, aprender o simplemente descubrir— y te mostramos opciones disponibles ahora.</p>';
      html += '<div class="tf-opening-grid" role="group" aria-label="¿Qué mazo va con lo que estás buscando?">';
      html += OPENING_OPTIONS.map(function (opt, i) {
        return '<button type="button" class="tf-opening-card" style="--tf-i:' + i + '" data-field="opening" data-value="' + escapeHtml(opt.value) + '">' + escapeHtml(opt.label) + '</button>';
      }).join('');
      html += '</div>';
      html += '<div class="tf-nav"><button type="button" class="tf-back">Cerrar</button></div>';
      html += '</div>';
      root.innerHTML = html;
      bindNav();
      var buttons = root.querySelectorAll('.tf-opening-card');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', (function (btn) {
          return function () { choose(btn.getAttribute('data-field'), btn.getAttribute('data-value')); };
        })(buttons[i]));
      }
      focusHeading();
    }

    function renderQuestion(step) {
      var q = QUESTIONS[step];
      var explainerOpen = step === 'system' && state.systemExplainerOpen;
      var options = explainerOpen ? q.explainerOptions : q.options;
      var selected = state.answers[q.field];
      var html = '';
      html += '<p class="tf-progress">Filtro ' + stepPosition(step) + ' de ' + stepTotal() + '</p>';
      html += '<div class="tf-question">';
      html += '<h3 tabindex="-1" id="tf-heading">' + escapeHtml(q.title) + '</h3>';
      if (explainerOpen) {
        html += '<div class="tf-explainer">' + q.explainer.map(function (e) {
          return '<div><strong>' + escapeHtml(e.title) + '</strong> — ' + escapeHtml(e.text) + '</div>';
        }).join('') + '</div>';
      }
      html += '<div class="tf-options" role="group" aria-label="' + escapeHtml(q.title) + '">';
      html += options.map(function (opt) {
        var pressed = selected === opt.value && !(step === 'system' && opt.value === 'unsure' && explainerOpen) ? 'true' : 'false';
        return '<button type="button" class="tf-option" data-field="' + escapeHtml(q.field) + '" data-value="' + escapeHtml(opt.value) + '" aria-pressed="' + pressed + '">' + escapeHtml(opt.label) + '</button>';
      }).join('');
      html += '</div></div>';
      html += '<div class="tf-nav">';
      html += '<button type="button" class="tf-back">‹ Volver</button>';
      html += '<button type="button" class="tf-restart">Reiniciar</button>';
      html += '</div>';
      root.innerHTML = html;
      bindNav();
      var buttons = root.querySelectorAll('.tf-option');
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].addEventListener('click', (function (btn) {
          return function () { choose(btn.getAttribute('data-field'), btn.getAttribute('data-value')); };
        })(buttons[i]));
      }
      focusHeading();
    }


    function renderResults() {
      var ranked = rankCandidates(dataset, state.answers);
      var html = '<div class="tf-results">';
      if (ranked.length === 0 && state.refining) {
        html += renderNearMiss();
      } else if (ranked.length === 0) {
        // Defensivo: con 0 restricciones hard activas esto no debería
        // pasar nunca (el dataset ya se validó no vacío en init()), pero
        // nunca termina en un mensaje seco sin salida.
        var message = buildNoResultsMessage(state.answers, pageUrl);
        var href = waBase + encodeURIComponent(message);
        html += '<h3 tabindex="-1" id="tf-heading">No encontramos ahora una coincidencia exacta.</h3>';
        html += '<div class="tf-empty"><p>Podemos buscarla por encargo.</p>';
        html += '<a class="tf-wa-cta" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">Pedí que te lo busquemos</a></div>';
      } else {
        html += '<h3 tabindex="-1" id="tf-heading">Encontramos ' + ranked.length + ' opci' + (ranked.length === 1 ? 'ón' : 'ones') + ' que coincide' + (ranked.length === 1 ? '' : 'n') + ' con lo que buscás</h3>';
        html += '<div class="tf-results-grid">';
        html += ranked.map(function (r, i) {
          return '<div class="tf-result-slot" style="--tf-i:' + i + '">' + resultCardHtml(r.candidate, state.answers) + '</div>';
        }).join('');
        html += '</div>';
        html += '<button type="button" class="tf-refine-cta">Afinar mi búsqueda</button>';
      }
      html += '<div class="tf-nav">';
      html += '<button type="button" class="tf-back">‹ Volver</button>';
      html += '<button type="button" class="tf-restart">Reiniciar</button>';
      html += '</div></div>';
      root.innerHTML = html;
      bindNav();
      var refineBtn = root.querySelector('.tf-refine-cta');
      if (refineBtn) refineBtn.addEventListener('click', startRefine);
      bindNearMissNav();
      focusHeading();
    }

    // Filtros avanzados con 0 resultados exactos: nunca "no encontramos"
    // seco. Antes de revelar cualquier alternativa (que ya relaja algo),
    // la persona elige explícitamente verlas o pedir la búsqueda manual.
    function renderNearMiss() {
      var html = '<h3 tabindex="-1" id="tf-heading">No tenemos ahora una opción que cumpla todo exactamente.</h3>';
      html += '<p class="tf-near-miss-sub">Estas son las alternativas más cercanas.</p>';
      var message = buildNoResultsMessage(state.answers, pageUrl);
      var waHref = waBase + encodeURIComponent(message);
      if (!state.alternativesRevealed) {
        html += '<div class="tf-near-miss-choice">';
        html += '<button type="button" class="tf-reveal-alternatives">Ver estas alternativas</button>';
        html += '<a class="tf-wa-cta" href="' + escapeHtml(waHref) + '" target="_blank" rel="noopener noreferrer">Pedí que te lo busquemos</a>';
        html += '</div>';
        return html;
      }
      var alternatives = findNearestAlternatives(alternativesPool, state.answers);
      if (alternatives.length === 0) {
        html += '<div class="tf-empty"><p>No encontramos ninguna alternativa cercana disponible.</p>';
        html += '<a class="tf-wa-cta" href="' + escapeHtml(waHref) + '" target="_blank" rel="noopener noreferrer">Pedí que te lo busquemos</a></div>';
        return html;
      }
      html += '<div class="tf-results-grid tf-alternatives-grid">';
      html += alternatives.map(function (alt, i) {
        var card = resultCardHtml(alt.candidate, state.answers);
        var reason = explainNearMiss(alt.candidate, state.answers, alt.violations);
        card = card.replace('</div></article>', '<p class="tf-near-miss-reason">' + escapeHtml(reason) + '</p></div></article>');
        return '<div class="tf-result-slot" style="--tf-i:' + i + '">' + card + '</div>';
      }).join('');
      html += '</div>';
      html += '<a class="tf-wa-cta tf-wa-cta-secondary" href="' + escapeHtml(waHref) + '" target="_blank" rel="noopener noreferrer">Pedí que te lo busquemos igual</a>';
      return html;
    }

    function bindNearMissNav() {
      var revealBtn = root.querySelector('.tf-reveal-alternatives');
      if (revealBtn) revealBtn.addEventListener('click', revealAlternatives);
    }

    function bindNav() {
      var back = root.querySelector('.tf-back');
      var restartBtn = root.querySelector('.tf-restart');
      if (back) back.addEventListener('click', goBack);
      if (restartBtn) restartBtn.addEventListener('click', restart);
    }

    function focusHeading() {
      var heading = document.getElementById('tf-heading');
      if (heading) heading.focus();
    }
  }
}());
