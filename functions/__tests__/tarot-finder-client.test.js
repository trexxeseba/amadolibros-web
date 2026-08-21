// TAROT-FINDER-1 — ejecuta el archivo REAL astro-front/public/tarot-finder.js
// dentro de un contexto vm.Node con un DOM mínimo simulado (sin jsdom, sin
// bundler) para probar:
//  - el flujo de estado real (FIX 1: "No estoy seguro/a" abre el
//    explicador sin avanzar; FIX 2: "volver" desde resultados va a la
//    última pregunta aplicable, nunca cierra salvo desde la primera;
//    FIX 3: cambiar de sistema limpia deckFamily);
//  - paridad servidor/cliente (FIX 5): compara pesos, hard constraints,
//    límite de resultados y desempate del script cliente contra
//    functions/_shared/tarot-finder-scoring.js, la implementación
//    canónica y testeada aparte.
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
        ...overrides,
    };
}

// ── FIX 1: "No estoy seguro/a" abre el explicador sin avanzar ───────────

test('FIX 1: elegir "No estoy seguro/a" la primera vez permanece en la pregunta de sistema y abre el explicador', () => {
    const hooks = loadClientHooks();
    const state0 = hooks.initialFinderState();
    assert.equal(state0.step, 'system');
    assert.equal(state0.systemExplainerOpen, false);

    const state1 = hooks.applyChoice(state0, 'system', 'unsure');
    assert.equal(state1.step, 'system', 'sigue en la pregunta de sistema, no avanzó a "intent"');
    assert.equal(state1.systemExplainerOpen, true, 'el explicador queda abierto');
    assert.equal(state1.answers.system, undefined, 'todavía no se confirmó ninguna respuesta de sistema');
});

test('FIX 1: con el explicador abierto, elegir Tarot/Oráculo/Lenormand confirma esa respuesta y avanza', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'system', 'unsure'); // abre explicador
    state = hooks.applyChoice(state, 'system', 'oraculo');
    assert.equal(state.answers.system, 'oraculo');
    assert.equal(state.step, 'intent');
    assert.equal(state.systemExplainerOpen, false);
});

test('FIX 1: "Seguir sin preferencia" (mismo value=unsure, con el explicador ya abierto) confirma unsure y avanza', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'system', 'unsure'); // abre explicador
    assert.equal(state.step, 'system');
    state = hooks.applyChoice(state, 'system', 'unsure'); // "Seguir sin preferencia"
    assert.equal(state.answers.system, 'unsure');
    assert.equal(state.step, 'intent', 'ahora sí avanza');
});

test('FIX 1: elegir Tarot/Oráculo/Lenormand directamente (sin pasar por "no estoy seguro") avanza normal, sin explicador', () => {
    const hooks = loadClientHooks();
    const state = hooks.applyChoice(hooks.initialFinderState(), 'system', 'tarot');
    assert.equal(state.answers.system, 'tarot');
    assert.equal(state.step, 'intent');
    assert.equal(state.systemExplainerOpen, false);
});

// ── FIX 2: "volver" desde resultados va a la última pregunta aplicable ──

test('FIX 2: applyGoBack desde el sub-estado del explicador vuelve a la vista simple de la MISMA pregunta, no cierra', () => {
    const hooks = loadClientHooks();
    const explainerState = hooks.applyChoice(hooks.initialFinderState(), 'system', 'unsure');
    const back = hooks.applyGoBack(explainerState);
    assert.notEqual(back, null, 'no debe señalar "cerrar"');
    assert.equal(back.step, 'system');
    assert.equal(back.systemExplainerOpen, false);
});

test('FIX 2: applyGoBack desde la primera pregunta real (sin explicador) señala "cerrar" (null)', () => {
    const hooks = loadClientHooks();
    const result = hooks.applyGoBack(hooks.initialFinderState());
    assert.equal(result, null);
});

test('FIX 2: prevStepFrom("results", answers) devuelve la última pregunta aplicable (guide), nunca cierra', () => {
    const hooks = loadClientHooks();
    assert.equal(hooks.prevStepFrom('results', { system: 'tarot' }), 'guide');
    assert.equal(hooks.prevStepFrom('results', { system: 'oraculo' }), 'guide');
});

test('FIX 2: recorrido completo hasta resultados y "volver" aterriza en guide, no cierra ni salta preguntas', () => {
    const hooks = loadClientHooks();
    let state = hooks.initialFinderState();
    state = hooks.applyChoice(state, 'system', 'tarot');
    state = hooks.applyChoice(state, 'intent', 'sin_preferencia');
    state = hooks.applyChoice(state, 'deckFamily', 'no_preference');
    state = hooks.applyChoice(state, 'language', 'no_preference');
    state = hooks.applyChoice(state, 'guide', 'no_importante');
    assert.equal(state.step, 'results');

    const back = hooks.applyGoBack(state);
    assert.notEqual(back, null);
    assert.equal(back.step, 'guide');
    assert.equal(back.answers.system, 'tarot', 'las respuestas previas se conservan al volver');
});

test('FIX 2: "cerrar" ocurre únicamente desde la primera pregunta (idx 0, sin explicador) — cualquier otro paso vuelve a la pregunta anterior', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'system', 'tarot');
    // en "intent" (segunda pregunta real): volver debe ir a "system", no cerrar
    const back = hooks.applyGoBack(state);
    assert.notEqual(back, null);
    assert.equal(back.step, 'system');
});

// ── FIX 3: cambiar de sistema limpia deckFamily ──────────────────────────

test('FIX 3: Tarot -> Rider-Waite-Smith -> volver a "system" y elegir Oráculo elimina deckFamily', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'system', 'tarot');
    state = hooks.applyChoice(state, 'intent', 'sin_preferencia');
    state = hooks.applyChoice(state, 'deckFamily', 'rider_waite_smith');
    assert.equal(state.answers.deckFamily, 'rider_waite_smith');

    // el usuario vuelve dos preguntas (deckFamily -> intent -> system) y cambia el sistema
    state = hooks.applyChoice(state, 'system', 'oraculo');
    assert.equal(state.answers.deckFamily, undefined, 'deckFamily debe desaparecer: oráculo no tiene familias de tarot');
    assert.equal(state.answers.system, 'oraculo');
});

test('FIX 3: Tarot -> Marsella -> Lenormand elimina deckFamily', () => {
    const hooks = loadClientHooks();
    let state = hooks.applyChoice(hooks.initialFinderState(), 'system', 'tarot');
    state = hooks.applyChoice(state, 'deckFamily', 'marsella');
    assert.equal(state.answers.deckFamily, 'marsella');
    state = hooks.applyChoice(state, 'system', 'lenormand');
    assert.equal(state.answers.deckFamily, undefined);
});

test('FIX 3: Tarot -> Thoth -> volver a "system" -> "no estoy seguro" (unsure) elimina deckFamily', () => {
    const hooks = loadClientHooks();
    // Simula al usuario de vuelta en la pregunta de sistema (vía
    // applyGoBack repetido en la app real) ya con tarot+thoth elegidos.
    const stateAtSystem = { step: 'system', answers: { system: 'tarot', deckFamily: 'thoth' }, systemExplainerOpen: false };

    // Primer click en "No estoy seguro/a": sólo abre el explicador — la
    // respuesta anterior (deckFamily) NO se toca todavía, nada se confirmó.
    let state = hooks.applyChoice(stateAtSystem, 'system', 'unsure');
    assert.equal(state.step, 'system');
    assert.equal(state.systemExplainerOpen, true);
    assert.equal(state.answers.deckFamily, 'thoth', 'con el explicador recién abierto, todavía no se confirmó ningún cambio');

    // "Seguir sin preferencia" confirma unsure recién acá.
    state = hooks.applyChoice(state, 'system', 'unsure');
    assert.equal(state.answers.system, 'unsure');
    assert.equal(state.answers.deckFamily, undefined, 'deckFamily eliminado al confirmar unsure');
});

test('FIX 3: los tres casos siguen devolviendo candidatos válidos cuando existen (deckFamily ya no restringe indebidamente)', () => {
    const hooks = loadClientHooks();
    const dataset = [
        candidate({ id: 'A', primary_type: 'oraculo' }),
        candidate({ id: 'B', primary_type: 'lenormand' }),
        candidate({ id: 'C', primary_type: 'tarot', deck_family: 'marsella' }), // no debería aparecer bajo answers sin deckFamily exigido si no matchea sistema
    ];
    const oraculoAnswers = { system: 'oraculo' }; // deckFamily ya fue eliminado por FIX 3
    const ranked = hooks.rankCandidates(dataset, oraculoAnswers);
    assert.deepEqual(ranked.map(r => r.candidate.id), ['A'], 'sin deckFamily colgado, el oráculo real aparece');
});

// ── FIX 5: paridad servidor/cliente — mismos pesos, mismas reglas ───────

test('FIX 5: los pesos de score del cliente coinciden exactamente con los del módulo canónico', () => {
    const hooks = loadClientHooks();
    // hooks.SCORE se construyó dentro del vm.context (otro "realm" de JS) —
    // JSON.stringify compara estructura/valores, no identidad de prototipo
    // (deepStrictEqual fallaría entre realms distintos aunque los datos
    // sean idénticos; ver también los otros dos usos abajo).
    assert.equal(JSON.stringify(hooks.SCORE), JSON.stringify(canonical.SCORE_WEIGHTS));
});

test('FIX 5: el límite de resultados del cliente coincide con el del módulo canónico (6)', () => {
    const hooks = loadClientHooks();
    assert.equal(hooks.MAX_RESULTS, 6);
});

test('FIX 5: passesHard del cliente coincide con passesHardConstraints canónico en una batería de casos', () => {
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

test('FIX 5: rankCandidates del cliente produce el MISMO orden y los mismos scores que rankTarotFinderCandidates canónico', () => {
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

test('FIX 5: explainMatch del cliente produce las mismas badges y sentence que explainMatch canónico', () => {
    const hooks = loadClientHooks();
    const c = candidate({ primary_type: 'tarot', deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'mazo_mas_guia' });
    const answers = { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si' };
    // JSON.stringify por la misma razón de realms distintos (ver arriba).
    assert.equal(JSON.stringify(hooks.explainMatch(c, answers)), JSON.stringify(canonical.explainMatch(c, answers)));
});

test('FIX 5: buildNoResultsMessage del cliente y buildFinderNoResultsMessage canónico producen el mismo texto', async () => {
    const hooks = loadClientHooks();
    const { buildWhatsAppMessage } = await import('../../shared/whatsapp-messages.js');
    const answers = { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'ingles', guide: 'si', intent: 'experiencia' };
    const page = 'https://www.amadolibros.com/libros/esoterismo-tarot';
    const clientMessage = hooks.buildNoResultsMessage(answers, page);
    const serverMessage = canonical.buildFinderNoResultsMessage(answers, { buildWhatsAppMessage, page });
    assert.equal(clientMessage, serverMessage);
});

// ── FIX 4: sin aria-haspopup (verificado también en tarot-finder-render.test.js sobre el HTML SSR) ──

test('FIX 4: el HTML de las preguntas nunca declara aria-haspopup (el Finder es inline, no un popup/menú/diálogo)', () => {
    const hooks = loadClientHooks();
    // No hay render() ejecutable sin DOM real acá (ver
    // tarot-finder-render.test.js para la verificación end-to-end del
    // botón "Empezar" en el HTML servidor); esta prueba deja constancia de
    // que ningún string del propio archivo fuente contiene aria-haspopup.
    assert.doesNotMatch(CLIENT_SOURCE, /aria-haspopup/);
});
