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
  // TAROT-FINDER-1 fix de paridad: todas las funciones puras de acá abajo
  // (sin DOM) se exponen también en window.__AmadoTarotFinderTestHooks,
  // exclusivamente para que functions/__tests__/tarot-finder-client.test.js
  // pueda ejecutar ESTE archivo real dentro de un harness de Node (con un
  // DOM mínimo simulado) y comparar sus resultados byte a byte contra
  // tarot-finder-scoring.js — no es una API pública, no se usa desde el
  // propio flujo de la UI.
  var STEP_ORDER = ['system', 'intent', 'family', 'language', 'guide'];
  var MAX_RESULTS = 6;
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

  // ---- Máquina de estados (sin DOM) --------------------------------------
  // Extraída aparte de init() a propósito: son las funciones que
  // functions/__tests__/tarot-finder-client.test.js ejercita para probar el
  // flujo real (FIX 1/2/3), no sólo el HTML estático.

  function relevantSteps(answers) {
    return STEP_ORDER.filter(function (s) { return s !== 'family' || answers.system === 'tarot'; });
  }

  function nextStepFrom(step, answers) {
    var order = relevantSteps(answers);
    var idx = order.indexOf(step);
    return idx >= 0 && idx < order.length - 1 ? order[idx + 1] : 'results';
  }

  // FIX 2: desde 'results' vuelve a la última pregunta aplicable (guide,
  // salvo que algún día se agregue una pregunta después). Desde la primera
  // pregunta real devuelve null -> sólo ahí "volver" puede cerrar.
  function prevStepFrom(step, answers) {
    var order = relevantSteps(answers);
    if (step === 'results') return order[order.length - 1];
    var idx = order.indexOf(step);
    return idx > 0 ? order[idx - 1] : null;
  }

  function initialFinderState() {
    return { step: 'system', answers: {}, systemExplainerOpen: false };
  }

  /**
   * Reductor puro: (estado, campo, valor) -> nuevo estado. No muta el
   * estado recibido.
   *
   * FIX 1: elegir "No estoy seguro/a" la PRIMERA vez en la pregunta de
   * sistema no avanza — sólo abre el explicador (systemExplainerOpen).
   * Sólo "Seguir sin preferencia" (mismo value='unsure', pero con el
   * explicador ya abierto) confirma system='unsure' y avanza.
   *
   * FIX 3: cambiar `system` a cualquier valor que no sea 'tarot' elimina
   * `answers.deckFamily` de inmediato — una tradición que ya no aplica
   * nunca puede seguir restringiendo el ranking.
   */
  function applyChoice(state, field, value) {
    var answers = {};
    for (var k in state.answers) if (Object.prototype.hasOwnProperty.call(state.answers, k)) answers[k] = state.answers[k];

    if (field === 'system' && value === 'unsure' && state.step === 'system' && !state.systemExplainerOpen) {
      return { step: 'system', answers: answers, systemExplainerOpen: true };
    }

    if (field === 'system' && value !== 'tarot') {
      delete answers.deckFamily;
    }
    answers[field] = value;

    var nextState = { step: state.step, answers: answers, systemExplainerOpen: false };
    nextState.step = nextStepFrom(state.step, answers);
    return nextState;
  }

  /** FIX 2: "volver" desde el sub-estado del explicador de sistema vuelve a
   * la vista simple de la misma pregunta, nunca cierra. */
  function applyGoBack(state) {
    if (state.step === 'system' && state.systemExplainerOpen) {
      return { step: 'system', answers: state.answers, systemExplainerOpen: false };
    }
    var prev = prevStepFrom(state.step, state.answers);
    if (prev === null) return null; // señal: cerrar el Finder
    return { step: prev, answers: state.answers, systemExplainerOpen: false };
  }

  var QUESTIONS = {
    system: {
      field: 'system',
      title: '¿Qué estás buscando?',
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
    intent: {
      field: 'intent',
      title: '¿Para qué lo querés?',
      options: [
        { value: 'primer_mazo', label: 'Es mi primer mazo' },
        { value: 'estudiar', label: 'Quiero aprender/estudiar' },
        { value: 'experiencia', label: 'Ya tengo experiencia' },
        { value: 'regalo', label: 'Es para regalar' },
        { value: 'coleccionista', label: 'Colecciono mazos' },
        { value: 'sin_preferencia', label: 'No tengo preferencia' },
      ],
    },
    family: {
      field: 'deckFamily',
      title: '¿Buscás alguna tradición en particular?',
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
    STEP_ORDER: STEP_ORDER, MAX_RESULTS: MAX_RESULTS, SCORE: SCORE, QUESTIONS: QUESTIONS,
    hasPreference: hasPreference, passesHard: passesHard, scoreCandidate: scoreCandidate,
    rankCandidates: rankCandidates, explainMatch: explainMatch, buildNoResultsMessage: buildNoResultsMessage,
    relevantSteps: relevantSteps, nextStepFrom: nextStepFrom, prevStepFrom: prevStepFrom,
    initialFinderState: initialFinderState, applyChoice: applyChoice, applyGoBack: applyGoBack,
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
    if (!section || !root || !startBtn || !dataEl) return;

    var waBase = section.getAttribute('data-wa-base') || '';
    var pageUrl = window.location.href.split('#')[0].split('?')[0];

    var dataset;
    try { dataset = JSON.parse(dataEl.textContent || '[]'); } catch (_e) { dataset = []; }
    if (!Array.isArray(dataset) || dataset.length === 0) return;

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
      if (state.step === 'results') renderResults();
      else renderQuestion(state.step);
    }

    function renderQuestion(step) {
      var q = QUESTIONS[step];
      var explainerOpen = step === 'system' && state.systemExplainerOpen;
      var options = explainerOpen ? q.explainerOptions : q.options;
      var selected = state.answers[q.field];
      // FIX 2/4: "Cerrar" sólo en la primera pregunta real y fuera del
      // sub-estado del explicador — desde ahí "volver" nunca cierra.
      var isFirst = stepPosition(step) === 1 && !explainerOpen;
      var html = '';
      html += '<p class="tf-progress">Pregunta ' + stepPosition(step) + ' de ' + stepTotal() + '</p>';
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
      html += '<button type="button" class="tf-back">' + (isFirst ? 'Cerrar' : '‹ Volver') + '</button>';
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
      if (ranked.length === 0) {
        var message = buildNoResultsMessage(state.answers, pageUrl);
        var href = waBase + encodeURIComponent(message);
        html += '<h3 tabindex="-1" id="tf-heading">No encontramos ahora una coincidencia exacta.</h3>';
        html += '<div class="tf-empty"><p>Podemos buscarla por encargo.</p>';
        html += '<a class="tf-wa-cta" href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">Pedí que te lo busquemos</a></div>';
      } else {
        html += '<h3 tabindex="-1" id="tf-heading">Encontramos ' + ranked.length + ' opci' + (ranked.length === 1 ? 'ón' : 'ones') + ' que coincide' + (ranked.length === 1 ? '' : 'n') + ' con lo que buscás</h3>';
        html += '<div class="tf-results-grid">';
        html += ranked.map(function (r) {
          var candidate = r.candidate;
          var ex = explainMatch(candidate, state.answers);
          var priceText = Number(candidate.price || 0).toLocaleString('es-UY');
          return '<article class="tf-result-card">' +
            (candidate.image ? '<img src="' + escapeHtml(candidate.image) + '" alt="Portada de ' + escapeHtml(candidate.title) + '" loading="lazy" decoding="async">' : '') +
            '<div class="tf-result-body">' +
            (ex.badges.length ? '<div class="tf-result-badges">' + ex.badges.map(function (b) { return '<span>' + escapeHtml(b) + '</span>'; }).join('') + '</div>' : '') +
            '<h4>' + escapeHtml(candidate.title) + '</h4>' +
            (ex.sentence ? '<p class="tf-result-why">' + escapeHtml(ex.sentence) + '</p>' : '') +
            '<p class="tf-result-price">$' + priceText + ' UYU</p>' +
            '<a class="tf-result-cta" href="' + escapeHtml(candidate.href) + '">Ver mazo</a>' +
            '</div></article>';
        }).join('');
        html += '</div>';
      }
      html += '<div class="tf-nav">';
      html += '<button type="button" class="tf-back">‹ Volver</button>';
      html += '<button type="button" class="tf-restart">Reiniciar</button>';
      html += '</div></div>';
      root.innerHTML = html;
      bindNav();
      focusHeading();
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
