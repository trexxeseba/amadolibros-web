// TAROT-FINDER-1 — lógica pura de filtrado (hard) y scoring (soft).
// Cubre exactamente los 18 puntos pedidos (17 acá, el de tamaño del
// dataset vive en tarot-finder-dataset.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFinderNoResultsMessage,
  explainMatch,
  explainNearMiss,
  findNearestTarotAlternatives,
  OPENING_OPTIONS,
  passesHardConstraints,
  rankTarotFinderCandidates,
  scoreTarotFinderCandidate,
  SCORE_WEIGHTS,
} from '../_shared/tarot-finder-scoring.js';
import { buildWhatsAppMessage } from '../../shared/whatsapp-messages.js';

function candidate(overrides = {}) {
  return {
    id: 'MLU1',
    title: 'Mazo de prueba',
    price: 2000,
    image: 'https://example.com/x.jpg',
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

// ── 1-3. Separación de sistemas ──────────────────────────────────────────

test('1. Tarot nunca devuelve Lenormand cuando el sistema es obligatorio', () => {
  const candidates = [candidate({ id: 'A', primary_type: 'tarot' }), candidate({ id: 'B', primary_type: 'lenormand' })];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'tarot' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['A']);
});

test('2. Oráculo nunca devuelve Tarot cuando el tipo es obligatorio', () => {
  const candidates = [candidate({ id: 'A', primary_type: 'tarot' }), candidate({ id: 'B', primary_type: 'oraculo' })];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'oraculo' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['B']);
});

test('3. Lenormand se conserva como sistema propio, no colapsa con tarot ni oráculo', () => {
  const candidates = [
    candidate({ id: 'A', primary_type: 'tarot' }),
    candidate({ id: 'B', primary_type: 'oraculo' }),
    candidate({ id: 'C', primary_type: 'lenormand' }),
  ];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'lenormand' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['C']);
});

test('sin preferencia de sistema ("unsure"), Kipper puede aparecer entre los candidatos', () => {
  const candidates = [candidate({ id: 'A', primary_type: 'tarot' }), candidate({ id: 'B', primary_type: 'kipper' })];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'unsure' });
  assert.deepEqual(new Set(ranked.map(r => r.candidate.id)), new Set(['A', 'B']));
});

// ── 4-6. Familia exacta ───────────────────────────────────────────────────

test('4. Rider-Waite-Smith exacto: no acepta Marsella ni Thoth ni sin-familia', () => {
  const candidates = [
    candidate({ id: 'A', deck_family: 'rider_waite_smith' }),
    candidate({ id: 'B', deck_family: 'marsella' }),
    candidate({ id: 'C', deck_family: 'thoth' }),
    candidate({ id: 'D', deck_family: null }),
  ];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'tarot', deckFamily: 'rider_waite_smith' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['A']);
});

test('5. Marsella exacto', () => {
  const candidates = [
    candidate({ id: 'A', deck_family: 'rider_waite_smith' }),
    candidate({ id: 'B', deck_family: 'marsella' }),
  ];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'tarot', deckFamily: 'marsella' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['B']);
});

test('6. Thoth exacto', () => {
  const candidates = [
    candidate({ id: 'A', deck_family: 'marsella' }),
    candidate({ id: 'B', deck_family: 'thoth' }),
  ];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'tarot', deckFamily: 'thoth' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['B']);
});

// ── 7-8. Unknown nunca satisface una exigencia exacta ────────────────────

test('7. idioma desconocido no satisface una exigencia de español', () => {
  const candidates = [candidate({ id: 'A', language: 'desconocido' }), candidate({ id: 'B', language: 'espanol' })];
  const ranked = rankTarotFinderCandidates(candidates, { language: 'espanol' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['B']);
});

test('8. guía desconocida no satisface "quiero guía"', () => {
  const candidates = [candidate({ id: 'A', bundle: 'desconocido' }), candidate({ id: 'B', bundle: 'mazo_mas_guia' })];
  const ranked = rankTarotFinderCandidates(candidates, { guide: 'si' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['B']);
});

test('idioma inglés exige exactamente inglés, no multilingüe ni desconocido', () => {
  const candidates = [
    candidate({ id: 'A', language: 'multilingue' }),
    candidate({ id: 'B', language: 'ingles' }),
    candidate({ id: 'C', language: 'desconocido' }),
  ];
  const ranked = rankTarotFinderCandidates(candidates, { language: 'ingles' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['B']);
});

// ── 9. Preferencia blanda ─────────────────────────────────────────────────

test('9. "primer mazo" es preferencia blanda: no excluye a quien no es level=principiante', () => {
  const candidates = [candidate({ id: 'A', level: 'desconocido' })];
  const ranked = rankTarotFinderCandidates(candidates, { intent: 'primer_mazo' });
  assert.equal(ranked.length, 1, 'sigue apareciendo aunque no sea "principiante" confirmado');
  assert.equal(ranked[0].score, 0, 'pero no recibe el bonus, porque el tag no lo confirma');
});

test('9b. "primer mazo" SÍ suma puntos cuando level=principiante está confirmado', () => {
  const { score, reasons } = scoreTarotFinderCandidate(candidate({ level: 'principiante' }), { intent: 'primer_mazo' });
  assert.equal(score, SCORE_WEIGHTS.PRINCIPIANTE_PARA_PRIMER_MAZO);
  assert.ok(reasons.includes('principiante'));
});

// ── 10-11. Resultados: 0 y máximo 6 ──────────────────────────────────────

test('10. sin matches hard -> 0 resultados', () => {
  const candidates = [candidate({ id: 'A', primary_type: 'oraculo' })];
  const ranked = rankTarotFinderCandidates(candidates, { system: 'tarot' });
  assert.deepEqual(ranked, []);
});

test('11. nunca más de 6 resultados aunque haya más candidatos válidos', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => candidate({ id: `MLU${i}` }));
  const ranked = rankTarotFinderCandidates(candidates, {});
  assert.equal(ranked.length, 6);
});

test('el límite es configurable pero 6 es el default', () => {
  const candidates = Array.from({ length: 20 }, (_, i) => candidate({ id: `MLU${i}` }));
  assert.equal(rankTarotFinderCandidates(candidates, {}).length, 6);
  assert.equal(rankTarotFinderCandidates(candidates, {}, { limit: 3 }).length, 3);
});

// ── 12-13. Determinismo y empate estable ─────────────────────────────────

test('12. el ranking es determinista: mismo input, mismo output', () => {
  const candidates = [
    candidate({ id: 'A', level: 'principiante' }),
    candidate({ id: 'B', bundle: 'mazo_mas_guia' }),
    candidate({ id: 'C' }),
  ];
  const answers = { intent: 'primer_mazo' };
  const first = rankTarotFinderCandidates(candidates, answers);
  const second = rankTarotFinderCandidates(candidates, answers);
  assert.deepEqual(first, second);
});

test('13. empate estable: score y stock y price iguales -> desempata por id ascendente', () => {
  const candidates = [
    candidate({ id: 'MLU3', stock: 5, price: 1000 }),
    candidate({ id: 'MLU1', stock: 5, price: 1000 }),
    candidate({ id: 'MLU2', stock: 5, price: 1000 }),
  ];
  const ranked = rankTarotFinderCandidates(candidates, {});
  assert.deepEqual(ranked.map(r => r.candidate.id), ['MLU1', 'MLU2', 'MLU3']);
});

test('desempate documentado: score DESC -> stock DESC -> price ASC -> id ASC', () => {
  const candidates = [
    candidate({ id: 'A', level: 'principiante', stock: 1, price: 3000 }), // score 30
    candidate({ id: 'B', stock: 10, price: 1000 }), // score 0, más stock
    candidate({ id: 'C', stock: 10, price: 500 }), // score 0, mismo stock que B, menor precio
  ];
  const ranked = rankTarotFinderCandidates(candidates, { intent: 'primer_mazo' });
  assert.deepEqual(ranked.map(r => r.candidate.id), ['A', 'C', 'B']);
});

// ── 14. Sólo activos/stock (a nivel de filtro hard, defensivo) ───────────

test('14. passesHardConstraints no depende de stock/status — esa exclusión ya la aplica buildTarotFinderDataset antes; acá se verifica que no se reintroduce accidentalmente', () => {
  // El dataset ya filtra activos+stock>0 antes de llegar acá (ver
  // tarot-finder-dataset.test.js). Esta prueba documenta que el filtrado
  // hard de esta capa es sólo semántico (sistema/familia/idioma/guía), no
  // duplica la validación de stock.
  const inStock = candidate({ id: 'A', stock: 1 });
  const noStockButPassedIn = candidate({ id: 'B', stock: 0 }); // no debería llegar acá en la práctica
  const ranked = rankTarotFinderCandidates([inStock, noStockButPassedIn], {});
  assert.equal(ranked.length, 2, 'esta capa no re-filtra por stock; esa responsabilidad es de buildTarotFinderDataset');
});

// ── 15. Explicación nunca afirma datos unknown ───────────────────────────

test('15. explainMatch nunca menciona idioma/familia desconocidos', () => {
  const { badges, sentence } = explainMatch(
    candidate({ language: 'desconocido', deck_family: null, bundle: 'desconocido' }),
    { system: 'tarot', language: 'no_preference' },
  );
  assert.deepEqual(badges, []);
  assert.doesNotMatch(sentence, /desconocido/i);
  assert.match(sentence, /Tarot/);
});

test('15b. explainMatch sólo menciona guía si bundle=mazo_mas_guia es verdadero', () => {
  const { badges: badgesSin } = explainMatch(candidate({ bundle: 'solo_mazo' }), {});
  assert.ok(!badgesSin.includes('Incluye guía'));
  const { badges: badgesCon } = explainMatch(candidate({ bundle: 'mazo_mas_guia' }), {});
  assert.ok(badgesCon.includes('Incluye guía'));
});

test('15c. explainMatch con familia y guía exigidas y confirmadas arma la frase completa', () => {
  const { sentence } = explainMatch(
    candidate({ primary_type: 'tarot', deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'mazo_mas_guia' }),
    { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si' },
  );
  assert.equal(sentence, 'Coincide porque buscás un Tarot Rider-Waite-Smith en español con guía.');
});

// ── 16. WhatsApp de no-resultados con respuestas reales ──────────────────

test('16. el mensaje de no-resultados incluye sólo las respuestas reales, en el formato del helper existente', () => {
  const message = buildFinderNoResultsMessage(
    { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si', intent: 'primer_mazo' },
    { buildWhatsAppMessage, page: '/libros/esoterismo-tarot' },
  );
  assert.match(message, /Tipo: Tarot/);
  assert.match(message, /Tradición: Rider-Waite-Smith/);
  assert.match(message, /Idioma: Español/);
  assert.match(message, /Guía: sí/);
  assert.match(message, /Experiencia: primer mazo/);
  assert.match(message, /No encontré una coincidencia exacta disponible/);
  assert.match(message, /amadolibros\.com\/libros\/esoterismo-tarot/);
});

test('16b. sin preferencias concretas (todo "no_preference"/"unsure"), no inventa líneas', () => {
  const message = buildFinderNoResultsMessage(
    { system: 'unsure', deckFamily: 'no_preference', language: 'no_preference', guide: 'no_importante', intent: 'sin_preferencia' },
    { buildWhatsAppMessage, page: '/libros/esoterismo-tarot' },
  );
  assert.doesNotMatch(message, /Tipo:/);
  assert.doesNotMatch(message, /Tradición:/);
  assert.doesNotMatch(message, /Idioma:/);
  assert.doesNotMatch(message, /Guía:/);
  assert.doesNotMatch(message, /Experiencia:/);
});

test('16c. buildFinderNoResultsMessage exige el helper real, no lo reimplementa', () => {
  assert.throws(() => buildFinderNoResultsMessage({}, {}), /requiere buildWhatsAppMessage/);
});

// ── 17. Input inválido no rompe ───────────────────────────────────────────

test('17. passesHardConstraints con candidato null/undefined no lanza', () => {
  assert.equal(passesHardConstraints(null, { system: 'tarot' }), false);
  assert.equal(passesHardConstraints(undefined, {}), false);
});

test('17b. rankTarotFinderCandidates con answers vacío/undefined no lanza y no filtra nada por hard constraints', () => {
  const candidates = [candidate({ id: 'A' }), candidate({ id: 'B', primary_type: 'oraculo' })];
  assert.doesNotThrow(() => rankTarotFinderCandidates(candidates, undefined));
  assert.equal(rankTarotFinderCandidates(candidates, {}).length, 2);
});

test('17c. rankTarotFinderCandidates lanza explícito sobre candidates que no es array (input realmente inválido)', () => {
  assert.throws(() => rankTarotFinderCandidates('no-array', {}), /candidates debe ser un array/);
});

test('17d. scoreTarotFinderCandidate con candidato vacío no lanza, score 0', () => {
  assert.deepEqual(scoreTarotFinderCandidate({}, { intent: 'primer_mazo' }), { score: 0, reasons: [] });
  assert.deepEqual(scoreTarotFinderCandidate(null, {}), { score: 0, reasons: [] });
});

test('17e. candidatos con campos parcialmente ausentes no rompen el ranking', () => {
  const broken = { id: 'X' }; // sin price/stock/primary_type/etc.
  assert.doesNotThrow(() => rankTarotFinderCandidates([broken], {}));
});

// ── TAROT-FINDER-UX-2: OPENING_OPTIONS (apertura del selector) ──────────

test('OPENING_OPTIONS: 7 opciones, cada una con value/label/intent', () => {
  assert.equal(OPENING_OPTIONS.length, 7);
  for (const option of OPENING_OPTIONS) {
    assert.ok(option.value);
    assert.ok(option.label);
    assert.ok('intent' in option);
  }
});

test('OPENING_OPTIONS: "Quiero aprender Tarot" mapea al intent existente estudiar (reutiliza el motor, no inventa uno nuevo)', () => {
  const learn = OPENING_OPTIONS.find(o => o.value === 'aprender');
  assert.equal(learn.intent, 'estudiar');
});

test('OPENING_OPTIONS: "Busco un regalo" mapea al intent existente regalo', () => {
  const gift = OPENING_OPTIONS.find(o => o.value === 'regalo');
  assert.equal(gift.intent, 'regalo');
});

test('OPENING_OPTIONS: las 4 opciones reflexivas (mirar adelante/claridad/decisión/entender) y "explorar" no fabrican una señal que el catálogo no tiene — sin_preferencia', () => {
  const reflective = ['mirar_adelante', 'claridad', 'decision', 'entender_situacion', 'explorar'];
  for (const value of reflective) {
    const option = OPENING_OPTIONS.find(o => o.value === value);
    assert.equal(option.intent, 'sin_preferencia', value);
  }
});

test('OPENING_OPTIONS: ningún label usa lenguaje predictivo ("va a ocurrir", "revela tu futuro")', () => {
  for (const option of OPENING_OPTIONS) {
    assert.doesNotMatch(option.label, /va a ocurrir|revela tu futuro|te espera|tu destino/i);
  }
});

// ── TAROT-FINDER-UX-2: findNearestTarotAlternatives ──────────────────────

test('findNearestTarotAlternatives: lanza explícito si pool no es array', () => {
  assert.throws(() => findNearestTarotAlternatives('no-array', {}), /pool debe ser un array/);
});

test('findNearestTarotAlternatives: sin restricciones hard activas, no hay "alternativas" (no aplica el concepto)', () => {
  const pool = [candidate({ id: 'A' }), candidate({ id: 'B' })];
  assert.deepEqual(findNearestTarotAlternatives(pool, {}), []);
});

test('findNearestTarotAlternatives: prioriza un candidato PAUSADO que cumple TODO por sobre uno activo con una violación', () => {
  const exactPaused = candidate({ id: 'P1', deck_family: 'rider_waite_smith', language: 'espanol', status: 'paused' });
  const partialActive = candidate({ id: 'A1', deck_family: 'rider_waite_smith', language: 'ingles', status: 'active' });
  const answers = { deckFamily: 'rider_waite_smith', language: 'espanol' };
  const result = findNearestTarotAlternatives([exactPaused, partialActive], answers);
  assert.equal(result[0].candidate.id, 'P1');
  assert.deepEqual(result[0].violations, []);
});

test('findNearestTarotAlternatives: ordena por MENOS restricciones violadas primero', () => {
  const oneViolation = candidate({ id: 'A', deck_family: 'rider_waite_smith', language: 'ingles' }); // falla language
  const twoViolations = candidate({ id: 'B', deck_family: 'marsella', language: 'ingles' }); // falla deckFamily + language
  const answers = { deckFamily: 'rider_waite_smith', language: 'espanol' };
  const result = findNearestTarotAlternatives([twoViolations, oneViolation], answers);
  assert.deepEqual(result.map(r => r.candidate.id), ['A', 'B']);
});

test('findNearestTarotAlternatives: un candidato que viola TODAS las restricciones activas igual aparece si es lo único disponible (todo el pool ya es tarot/oráculo/lenormand/kipper)', () => {
  const sharesNothing = candidate({ id: 'Z', primary_type: 'lenormand', deck_family: null, language: 'ingles', bundle: 'desconocido' });
  const answers = { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si' };
  const result = findNearestTarotAlternatives([sharesNothing], answers);
  assert.equal(result.length, 1);
  assert.equal(result[0].violations.length, 4);
});

test('findNearestTarotAlternatives: un candidato que viola menos restricciones siempre se prioriza sobre uno que las viola todas', () => {
  // Cumple deckFamily+language+guide, sólo falla system: 1 de 4 violadas.
  const violatesOne = candidate({ id: 'A', primary_type: 'oraculo', deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'mazo_mas_guia' });
  const violatesAll = candidate({ id: 'Z', primary_type: 'lenormand', deck_family: null, language: 'ingles', bundle: 'desconocido' });
  const answers = { system: 'tarot', deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si' };
  const result = findNearestTarotAlternatives([violatesAll, violatesOne], answers);
  assert.deepEqual(result.map(r => r.candidate.id), ['A', 'Z']);
});

test('findNearestTarotAlternatives: nunca devuelve más de `limit` (default 3)', () => {
  const answers = { language: 'espanol' };
  const pool = Array.from({ length: 10 }, (_, i) => candidate({ id: `X${i}`, language: 'ingles' }));
  assert.equal(findNearestTarotAlternatives(pool, answers).length, 3);
  assert.equal(findNearestTarotAlternatives(pool, answers, { limit: 1 }).length, 1);
});

test('findNearestTarotAlternatives: determinismo — mismo input, mismo orden, sin importar el orden de entrada', () => {
  const answers = { deckFamily: 'rider_waite_smith', language: 'espanol' };
  const a = candidate({ id: 'A', deck_family: 'rider_waite_smith', language: 'ingles' });
  const b = candidate({ id: 'B', deck_family: 'marsella', language: 'espanol' });
  const forward = findNearestTarotAlternatives([a, b], answers).map(r => r.candidate.id);
  const reversed = findNearestTarotAlternatives([b, a], answers).map(r => r.candidate.id);
  assert.deepEqual(forward, reversed);
});

// ── TAROT-FINDER-UX-2: explainNearMiss ────────────────────────────────────

test('explainNearMiss: "Está en español y es Rider-Waite-Smith, pero no incluye guía." (estilo del ejemplo pedido)', () => {
  const c = candidate({ deck_family: 'rider_waite_smith', language: 'espanol', bundle: 'desconocido' });
  const answers = { deckFamily: 'rider_waite_smith', language: 'espanol', guide: 'si' };
  const text = explainNearMiss(c, answers, ['guide']);
  assert.match(text, /español/i);
  assert.match(text, /Rider-Waite-Smith/);
  assert.match(text, /pero no incluye guía\.$/);
});

test('explainNearMiss: "Incluye guía y es Tarot, pero está en inglés." (estilo del ejemplo pedido)', () => {
  const c = candidate({ primary_type: 'tarot', language: 'ingles', bundle: 'mazo_mas_guia' });
  const answers = { system: 'tarot', language: 'espanol', guide: 'si' };
  const text = explainNearMiss(c, answers, ['language']);
  assert.match(text, /guía/i);
  assert.match(text, /Tarot/);
  assert.match(text, /pero no está en Español\.$/);
});

test('explainNearMiss: candidato pausado que cumple todo -> "Cumple ..., disponible por encargo." (estilo del ejemplo pedido)', () => {
  const c = candidate({ deck_family: 'rider_waite_smith', status: 'paused' });
  const answers = { deckFamily: 'rider_waite_smith' };
  const text = explainNearMiss(c, answers, []);
  assert.match(text, /^Cumple/);
  assert.match(text, /disponible por encargo\.$/);
});

test('explainNearMiss: nunca miente — sólo menciona restricciones que answers realmente activó', () => {
  const c = candidate({ deck_family: 'rider_waite_smith', language: 'ingles' });
  const answers = { deckFamily: 'rider_waite_smith', language: 'espanol' }; // guide nunca se pidió
  const text = explainNearMiss(c, answers, ['language']);
  assert.doesNotMatch(text, /guía/i);
});
