// TAROT-FINDER-UX-2 — ejecuta el archivo REAL astro-front/public/
// tarot-finder.js dentro de un contexto vm.Node con un DOM mínimo simulado
// (sin jsdom, sin bundler) para probar el recomendador progresivo:
//  - primer clic en la apertura -> resultados inmediatos, sin exigir
//    sistema/tradición/idioma/guía antes;
//  - "Solo quiero explorar" -> resultados;
//  - "Afinar mi búsqueda" es opcional y nunca se activa sola;
//  - los hard constraints nunca se relajan en silencio;
//  - 0 resultados exactos con filtros activos -> alternativas cercanas,
//    reveladas sólo tras una elección explícita, con la explicación
//    correcta de qué restricción falla cada una;
//  - máximo 6 resultados, determinismo, "Volver";
//  - paridad servidor/cliente contra functions/_shared/tarot-finder-scoring.js.
//
// window.__AmadoTarotFinderTestHooks es una superficie de sólo-test que
// tarot-finder.js expone a propósito (ver comentario en ese archivo) —
// nunca se usa desde el flujo real de la UI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import * as canonical from '../_shared/tarot-finder-scoring.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_SCRIPT_PATH = path.resolve(__dirname, '../../astro-front/public/tarot-finder.js');
const CLIENT_SOURCE = readFileSync(CLIENT_SCRIPT_PATH, 'utf8');

function loadClientHooks() {
    const sandbox = {
        document: {
            readyState: 'complete',
            addEventListener() {},
            getElementById() { return null; },
        },
        window: {},
        console,
    };
    vm.createContext(sandbox);
    vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'tarot-finder.js' });
    const hooks = sandbox.window.__AmadoTarotFinderTestHooks;
    assert.ok(hooks, 'tarot-finder.js no expuso window.__AmadoTarotFinderTestHooks — el harness no puede probar el archivo real');
    return hooks;
}

function candidate(overrides = {}) {
    return {
        id: 'MLU1',
        title: 'Mazo de prueba',
        price: 2000,
        image: 'https://example.com/x.jpg',
        href: 'https://www.amadolibros.com/libro/MLU1/slug',
        primary_type: 'tarot',
        deck_family: null,
        language: 'desconocido',
        bundle: 'desconocido',
        level: 'desconocido',
        edition_style: null,
        stock: 3,
        status: 'active',
        ...overrides,
    };
}

// ── Primer clic en la apertura -> resultados inmediatos ─────────────────

test('el estado inicial arranca en "opening", nunca en una pregunta de sistema/tradición/idioma/guía', () => {
    const hooks = loadClientHooks();
    const state = hooks.initialFinderState();
    assert.equal(state.step, 'opening');
    assert.equal(state.refining, false);
    // JSON.stringify, no deepEqual: state.answers viene del "realm" del vm
    // sandbox, con su propio Object — deepEqual compara prototipo/identidad
    // de constructor entre realms distintos, no sólo estructura (mismo
    // motivo documentado en las comparaciones de abajo).
    assert.equal(JSON.stringify(state.answers), '{}');
});

test('primer clic (cualquier intención de apertura) va DIRECTO a resultados — nunca exige tradición/idioma/guía antes, y `system` sólo se fija cuando la opción lo promete explícitamente', () => {
    const hooks = loadClientHooks();
    for (const option of hooks.OPENING_OPTIONS) {
        const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', option.value);
        assert.equal(state.step, 'results', `opción "${option.value}" no fue directo a resultados`);
        assert.equal(state.answers.system, option.system, `opción "${option.value}"`);
        assert.equal(state.answers.deckFamily, undefined);
        assert.equal(state.answers.language, undefined);
        assert.equal(state.answers.guide, undefined);
    }
});

test('"Quiero explorar" -> resultados, con intent sin_preferencia (no fabrica una señal falsa)', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    assert.equal(state.step, 'results');
    assert.equal(state.answers.intent, 'sin_preferencia');
    assert.equal(state.answers.system, undefined);
});

test('"Quiero aprender Tarot" mapea a intent=estudiar Y fija system=tarot (fix post-Preview FIX 5 — es exactamente lo que promete)', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'aprender_tarot');
    assert.equal(state.answers.intent, 'estudiar');
    assert.equal(state.answers.system, 'tarot');
});

test('"Es mi primer mazo" mapea a intent=primer_mazo', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'primer_mazo');
    assert.equal(state.answers.intent, 'primer_mazo');
    assert.equal(state.answers.system, undefined);
});

test('"Ya tengo experiencia" mapea a intent=experiencia', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'experiencia');
    assert.equal(state.answers.intent, 'experiencia');
});

test('"Colecciono mazos" mapea a intent=coleccionista', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'coleccionista');
    assert.equal(state.answers.intent, 'coleccionista');
});

test('"Busco un regalo" mapea a intent=regalo', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'regalo');
    assert.equal(state.answers.intent, 'regalo');
});

test('con sólo la intención de apertura elegida, rankCandidates devuelve resultados sin ningún hard constraint activo', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    const dataset = [candidate({ id: 'A' }), candidate({ id: 'B', primary_type: 'oraculo' })];
    const ranked = hooks.rankCandidates(dataset, state.answers);
    assert.equal(ranked.length, 2, 'sin sistema/tradición/idioma/guía exigidos, ambos pasan');
});

// ── "Afinar mi búsqueda" es opcional — nunca se activa sola ─────────────

test('applyStartRefine entra a la primera pregunta del refinamiento y marca refining=true', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    assert.equal(state.refining, false, 'refining sigue false hasta que la persona elige refinar');
    state = hooks.applyStartRefine(state);
    assert.equal(state.step, 'system');
    assert.equal(state.refining, true);
});

test('sin clickear "Afinar mi búsqueda", results.refining nunca pasa a true por sí solo', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'aprender_tarot');
    assert.equal(state.step, 'results');
    assert.equal(state.refining, false);
});

test('dentro del refinamiento, cada pregunta sigue ofreciendo una opción neutra ("no tengo preferencia"/"no es importante") — nunca obliga a comprometerse', () => {
    const hooks = loadClientHooks();
    for (const step of ['family', 'language']) {
        const q = hooks.QUESTIONS[step];
        assert.ok(q.options.some(o => o.value === 'no_preference'), `${step} sin opción neutra`);
    }
    assert.ok(hooks.QUESTIONS.guide.options.some(o => o.value === 'no_importante'));
});

// ── Hard constraints nunca se relajan en silencio ─────────────────────────

test('un candidato que no cumple un hard constraint activo NUNCA aparece en rankCandidates', () => {
    const hooks = loadClientHooks();
    const dataset = [candidate({ id: 'A', primary_type: 'tarot' }), candidate({ id: 'B', primary_type: 'oraculo' })];
    const ranked = hooks.rankCandidates(dataset, { system: 'tarot' });
    assert.deepEqual(ranked.map(r => r.candidate.id), ['A']);
});

test('passesHard del cliente coincide con passesHardConstraints canónico en una batería de casos', () => {
    const hooks = loadClientHooks();
    const cases = [
        [candidate({ primary_type: 'tarot' }), { system: 'tarot' }],
        [candidate({ primary_type: 'lenormand' }), { system: 'tarot' }],
        [candidate({ language: 'desconocido' }), { language: 'espanol' }],
        [candidate({ language: 'espanol' }), { language: 'espanol' }],
        [candidate({ bundle: 'desconocido' }), { guide: 'si' }],
        [candidate({ bundle: 'mazo_mas_guia' }), { guide: 'si' }],
        [candidate({ deck_family: 'thoth' }), { system: 'tarot', deckFamily: 'rider_waite_smith' }],
        [candidate({}), {}],
    ];
    for (const [c, answers] of cases) {
        assert.equal(hooks.passesHard(c, answers), canonical.passesHardConstraints(c, answers), JSON.stringify({ c, answers }));
    }
});

// ── FIX 3 (heredado de TAROT-FINDER-1): cambiar de sistema limpia deckFamily ──

test('cambiar `system` a algo que no sea tarot elimina deckFamily de inmediato', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    state = hooks.applyChoice(state, 'system', 'tarot');
    state = hooks.applyChoice(state, 'deckFamily', 'rider_waite_smith');
    assert.equal(state.answers.deckFamily, 'rider_waite_smith');
    state = hooks.applyChoice(state, 'system', 'oraculo');
    assert.equal(state.answers.deckFamily, undefined, 'oráculo no tiene familias de tarot');
});

test('"No estoy seguro/a" la primera vez en `system` sólo abre el explicador, no confirma ni avanza', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    const withExplainer = hooks.applyChoice(state, 'system', 'unsure');
    assert.equal(withExplainer.step, 'system');
    assert.equal(withExplainer.systemExplainerOpen, true);
    assert.equal(withExplainer.answers.system, undefined);
});

// ── 0 resultados exactos -> alternativas cercanas, reveladas explícitamente ──

test('0 resultados exactos con refining=true no termina en un mensaje seco: results.refining habilita la búsqueda de alternativas', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    state = hooks.applyChoice(state, 'system', 'tarot');
    state = hooks.applyChoice(state, 'deckFamily', 'thoth');
    state = hooks.applyChoice(state, 'language', 'espanol');
    state = hooks.applyChoice(state, 'guide', 'si');
    assert.equal(state.step, 'results');
    assert.equal(state.refining, true);

    const dataset = [candidate({ id: 'A', deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'desconocido' })];
    const ranked = hooks.rankCandidates(dataset, state.answers);
    assert.equal(ranked.length, 0, 'ningún candidato activo cumple thoth+español+guía exactamente');

    const alternatives = hooks.findNearestAlternatives(dataset, state.answers);
    assert.ok(alternatives.length > 0, 'debe haber al menos una alternativa cercana');
});

test('las alternativas NO se revelan solas — alternativesRevealed arranca false y sólo cambia con applyRevealAlternatives', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    state = hooks.applyChoice(state, 'system', 'tarot');
    state = hooks.applyChoice(state, 'deckFamily', 'thoth');
    state = hooks.applyChoice(state, 'language', 'no_preference');
    state = hooks.applyChoice(state, 'guide', 'no_importante');
    assert.equal(state.alternativesRevealed, false);

    const revealed = hooks.applyRevealAlternatives(state);
    assert.equal(revealed.alternativesRevealed, true);
    assert.equal(revealed.step, 'results', 'revelar alternativas no cambia de paso, sólo el sub-estado');
});

test('explainNearMiss del cliente produce el mismo texto que explainNearMiss canónico', () => {
    const hooks = loadClientHooks();
    const c = candidate({ deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'desconocido' });
    const answers = { deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si' };
    const clientText = hooks.explainNearMiss(c, answers, ['guide']);
    const serverText = canonical.explainNearMiss(c, answers, ['guide']);
    assert.equal(clientText, serverText);
    assert.match(clientText, /pero no incluye guía\.$/);
});

test('findNearestAlternatives del cliente produce el MISMO orden que findNearestTarotAlternatives canónico', () => {
    const hooks = loadClientHooks();
    const pool = [
        candidate({ id: 'A', deck_family: 'marsella', language: 'ingles' }),
        candidate({ id: 'B', deck_family: 'rider_waite_smith', language: 'ingles' }),
        candidate({ id: 'P', deck_family: 'rider_waite_smith', language: 'espanol', status: 'paused' }),
    ];
    const answers = { deckFamily: 'rider_waite_smith', language: 'espanol' };
    const clientResult = hooks.findNearestAlternatives(pool, answers).map(r => r.candidate.id);
    const serverResult = canonical.findNearestTarotAlternatives(pool, answers).map(r => r.candidate.id);
    // JSON.stringify: el array devuelto por hooks.* se construyó dentro del
    // vm sandbox (otro "realm"), deepEqual compara prototipo de Array entre
    // realms distintos, no sólo el contenido.
    assert.equal(JSON.stringify(clientResult), JSON.stringify(serverResult));
    assert.equal(clientResult[0], 'P', 'el pausado que cumple todo va primero');
});

// ── Máximo 6 resultados ────────────────────────────────────────────────────

test('rankCandidates nunca devuelve más de 6, aunque haya más candidatos válidos', () => {
    const hooks = loadClientHooks();
    const dataset = Array.from({ length: 20 }, (_, i) => candidate({ id: `MLU${i}` }));
    const ranked = hooks.rankCandidates(dataset, {});
    assert.equal(ranked.length, 6);
    assert.equal(hooks.MAX_RESULTS, 6);
});

test('findNearestAlternatives nunca devuelve más de MAX_ALTERNATIVES (3)', () => {
    const hooks = loadClientHooks();
    // Cada candidato cumple deckFamily pero no language — 1 de 2 blandas
    // violadas, admisible (fix post-Preview: debe compartir al menos una).
    const pool = Array.from({ length: 10 }, (_, i) => candidate({ id: `MLU${i}`, deck_family: 'rider_waite_smith', language: 'ingles' }));
    const alternatives = hooks.findNearestAlternatives(pool, { deckFamily: 'rider_waite_smith', language: 'espanol' });
    assert.equal(alternatives.length, 3);
    assert.equal(hooks.MAX_ALTERNATIVES, 3);
});

// ── Determinismo ───────────────────────────────────────────────────────────

test('rankCandidates es determinista: mismo input, mismo orden, sin importar el orden de entrada del dataset', () => {
    const hooks = loadClientHooks();
    const a = candidate({ id: 'A', stock: 5, price: 1000 });
    const b = candidate({ id: 'B', stock: 5, price: 1000 });
    const forward = hooks.rankCandidates([a, b], {}).map(r => r.candidate.id);
    const reversed = hooks.rankCandidates([b, a], {}).map(r => r.candidate.id);
    assert.deepEqual(forward, reversed);
});

test('applyChoice/applyStartRefine producen el mismo estado final para la misma secuencia de acciones, en llamadas separadas', () => {
    const hooks = loadClientHooks();
    function run() {
        let s = hooks.initialFinderState();
        s = hooks.applyChoice(s, 'opening', 'aprender_tarot');
        s = hooks.applyStartRefine(s);
        s = hooks.applyChoice(s, 'system', 'tarot');
        s = hooks.applyChoice(s, 'deckFamily', 'rider_waite_smith');
        return s;
    }
    assert.deepEqual(run(), run());
});

// ── "Volver" ────────────────────────────────────────────────────────────

test('"Volver" desde la apertura (primera pantalla real) señala "cerrar" (null)', () => {
    const hooks = loadClientHooks();
    const result = hooks.applyGoBack(hooks.initialFinderState());
    assert.equal(result, null);
});

test('"Volver" desde resultados SIN haber refinado nunca vuelve a "opening", no cierra', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    const back = hooks.applyGoBack(state);
    assert.notEqual(back, null);
    assert.equal(back.step, 'opening');
});

test('"Volver" desde resultados HABIENDO refinado va a la última pregunta del refinamiento (guide), no a "opening"', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    state = hooks.applyChoice(state, 'system', 'tarot');
    state = hooks.applyChoice(state, 'deckFamily', 'no_preference');
    state = hooks.applyChoice(state, 'language', 'no_preference');
    state = hooks.applyChoice(state, 'guide', 'no_importante');
    assert.equal(state.step, 'results');

    const back = hooks.applyGoBack(state);
    assert.notEqual(back, null);
    assert.equal(back.step, 'guide');
    assert.equal(back.answers.system, 'tarot', 'las respuestas previas se conservan al volver');
});

test('"Volver" desde el primer paso del refinamiento (system) vuelve a resultados, no cierra', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    assert.equal(state.step, 'system');
    const back = hooks.applyGoBack(state);
    assert.notEqual(back, null);
    assert.equal(back.step, 'results');
});

test('"Volver" desde la pantalla de alternativas reveladas oculta las alternativas antes de salir de resultados', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    state = hooks.applyChoice(state, 'system', 'tarot');
    state = hooks.applyChoice(state, 'deckFamily', 'thoth');
    state = hooks.applyChoice(state, 'language', 'no_preference');
    state = hooks.applyChoice(state, 'guide', 'no_importante');
    state = hooks.applyRevealAlternatives(state);
    assert.equal(state.alternativesRevealed, true);

    const back = hooks.applyGoBack(state);
    assert.equal(back.step, 'results');
    assert.equal(back.alternativesRevealed, false);
});

test('"Volver" desde el sub-estado del explicador de sistema vuelve a la vista simple de la MISMA pregunta, no cierra', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'opening', 'explorar');
    state = hooks.applyStartRefine(state);
    const explainerState = hooks.applyChoice(state, 'system', 'unsure');
    const back = hooks.applyGoBack(explainerState);
    assert.notEqual(back, null);
    assert.equal(back.step, 'system');
    assert.equal(back.systemExplainerOpen, false);
});

// ── Paridad servidor/cliente ────────────────────────────────────────────

test('los pesos de score del cliente coinciden exactamente con los del módulo canónico', () => {
    const hooks = loadClientHooks();
    assert.equal(JSON.stringify(hooks.SCORE), JSON.stringify(canonical.SCORE_WEIGHTS));
});

test('OPENING_OPTIONS del cliente coincide exactamente con el módulo canónico', () => {
    const hooks = loadClientHooks();
    assert.equal(JSON.stringify(hooks.OPENING_OPTIONS), JSON.stringify(canonical.OPENING_OPTIONS));
});

test('rankCandidates del cliente produce el MISMO orden y los mismos scores que rankTarotFinderCandidates canónico', () => {
    const hooks = loadClientHooks();
    const dataset = [
        candidate({ id: 'A', level: 'principiante', stock: 1, price: 3000 }),
        candidate({ id: 'B', stock: 10, price: 1000 }),
        candidate({ id: 'C', stock: 10, price: 500 }),
        candidate({ id: 'D', bundle: 'mazo_mas_guia', stock: 2, price: 2000 }),
        candidate({ id: 'E', primary_type: 'oraculo' }),
    ];
    const scenarios = [
        {},
        { system: 'tarot' },
        { intent: 'primer_mazo' },
        { intent: 'estudiar', guide: 'no_importante' },
        { system: 'oraculo' },
    ];
    for (const answers of scenarios) {
        const clientRanked = hooks.rankCandidates(dataset, answers).map(r => ({ id: r.candidate.id, score: r.score }));
        const serverRanked = canonical.rankTarotFinderCandidates(dataset, answers).map(r => ({ id: r.candidate.id, score: r.score }));
        assert.deepEqual(clientRanked, serverRanked, `orden/score distinto para answers=${JSON.stringify(answers)}`);
    }
});

test('explainMatch del cliente produce las mismas badges y sentence que explainMatch canónico', () => {
    const hooks = loadClientHooks();
    const c = candidate({ primary_type: 'tarot', deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'mazo_mas_guia' });
    const answers = { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si' };
    assert.equal(JSON.stringify(hooks.explainMatch(c, answers)), JSON.stringify(canonical.explainMatch(c, answers)));
});

test('buildNoResultsMessage del cliente y buildFinderNoResultsMessage canónico producen el mismo texto', async () => {
    const hooks = loadClientHooks();
    const { buildWhatsAppMessage } = await import('../../shared/whatsapp-messages.js');
    const answers = { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'ingles', guide: 'si', intent: 'experiencia' };
    const page = 'https://www.amadolibros.com/libros/esoterismo-tarot';
    const clientMessage = hooks.buildNoResultsMessage(answers, page);
    const serverMessage = canonical.buildFinderNoResultsMessage(answers, { buildWhatsAppMessage, page });
    assert.equal(clientMessage, serverMessage);
});

test('el HTML de las preguntas nunca declara aria-haspopup (el Finder es inline, no un popup/menú/diálogo)', () => {
    assert.doesNotMatch(CLIENT_SOURCE, /aria-haspopup/);
});

test('el archivo respeta prefers-reduced-motion (no se anima nada hardcodeado sin poder desactivarse) — verificado sobre el CSS servidor en tarot-finder-render.test.js', () => {
    // Guard de humo: el propio script cliente no dispara animaciones vía
    // setTimeout/rAF manuales que prefers-reduced-motion no pueda cortar —
    // toda la animación vive en CSS (ver TAROT_FINDER_STYLES), no acá.
    assert.doesNotMatch(CLIENT_SOURCE, /requestAnimationFrame|setTimeout/);
});

// ── FIX 1 (post-Preview): un candidato pausado nunca muestra $0 ─────────

test('resultCardHtml: un candidato ACTIVO muestra precio real y CTA "Ver mazo"', () => {
    const hooks = loadClientHooks();
    const html = hooks.resultCardHtml(candidate({ price: 2500, status: 'active' }), {});
    assert.match(html, /\$2\.500 UYU/);
    assert.match(html, />Ver mazo</);
    assert.doesNotMatch(html, /Consultar este mazo/);
    assert.doesNotMatch(html, /Lo podemos buscar por encargo/);
});

test('resultCardHtml: un candidato PAUSADO nunca muestra $0 — badge "Lo podemos buscar por encargo" y CTA "Consultar este mazo"', () => {
    const hooks = loadClientHooks();
    const html = hooks.resultCardHtml(candidate({ price: null, stock: null, status: 'paused' }), {});
    assert.doesNotMatch(html, /\$0/, 'nunca debe aparecer un precio inventado');
    assert.doesNotMatch(html, /UYU/, 'sin precio real, no hay cifra en UYU');
    assert.match(html, /Lo podemos buscar por encargo/);
    assert.match(html, />Consultar este mazo</);
    assert.doesNotMatch(html, />Ver mazo</);
});

test('resultCardHtml: un candidato pausado con price=0/stock=0 explícitos (no null) tampoco muestra $0 — el status manda, no el valor numérico', () => {
    const hooks = loadClientHooks();
    const html = hooks.resultCardHtml(candidate({ price: 0, stock: 0, status: 'paused' }), {});
    assert.doesNotMatch(html, /\$0/);
    assert.match(html, /Lo podemos buscar por encargo/);
});

test('resultCardHtml: el copy nunca dice "disponible por encargo" (fix post-Preview: pausado no es disponibilidad confirmada)', () => {
    const hooks = loadClientHooks();
    const html = hooks.resultCardHtml(candidate({ status: 'paused' }), {});
    assert.doesNotMatch(html, /disponible por encargo/i);
});
