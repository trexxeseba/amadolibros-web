// TAROT-MERCH-TAGS-1 — clasificación determinista del universo Tarot &
// Oráculos. Cubre exactamente las categorías de test pedidas: Rider/Ryder,
// Waite/Smith, Rider-Waite-Smith, Marsella, Thoth, Lenormand, Kipper,
// oracle/oráculo, libro vs mazo, idioma, mazo+guía, duplicados, falsos
// positivos, datos insuficientes -> desconocido.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTarotMerchTags,
  classifyBundle,
  classifyDeckFamily,
  classifyFormat,
  classifyItem,
  classifyLanguage,
  classifyLevel,
  classifyPrimaryType,
  dedupeKey,
  detectRestockedIds,
  isNewArrival,
  needsReview,
  tarotTagsModuleSource,
} from '../../scripts/seo/generate-tarot-merch-tags.mjs';

function item(overrides = {}) {
  return {
    id: 'MLU1',
    title: 'Tarot de prueba',
    author: null,
    status: 'active',
    available_quantity: 1,
    isbn: null,
    start_time: null,
    bibliographic: null,
    description: '',
    ...overrides,
  };
}

function norm(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// ── Rider / Ryder, Waite / Smith, Rider-Waite-Smith ─────────────────────

test('deck_family: Rider Waite estándar', () => {
  assert.equal(classifyDeckFamily('tarot', norm('Tarot Rider Waite Original 78 Cartas')), 'rider_waite_smith');
});

test('deck_family: variante de tipeo Ryder (común en catálogos migrados)', () => {
  assert.equal(classifyDeckFamily('tarot', norm('Tarot Ryder Waite Clasico')), 'rider_waite_smith');
});

test('deck_family: variante Waite-Smith / Smith-Waite', () => {
  assert.equal(classifyDeckFamily('tarot', norm('Tarot Smith-Waite Centennial Edition')), 'rider_waite_smith');
  assert.equal(classifyDeckFamily('tarot', norm('Waite-Smith Tarot Deck')), 'rider_waite_smith');
});

test('deck_family: Universal Waite cuenta como Rider-Waite-Smith', () => {
  assert.equal(classifyDeckFamily('tarot', norm('Tarot Universal Waite Pamela Colman Smith')), 'rider_waite_smith');
});

test('deck_family: "Waite" o "Smith" solos NO son evidencia suficiente (apellidos comunes)', () => {
  assert.equal(classifyDeckFamily('tarot', norm('Tarot ilustrado de Antonio Smith')), null);
  assert.equal(classifyDeckFamily('tarot', norm('El diario de Waite, novela')), null);
});

test('deck_family: sólo aplica si primary_type es tarot', () => {
  // "Rider Waite" mencionado en un contexto que no clasificó como tarot no debería aplicar,
  // pero la función recibe primaryType explícito para dejar esa decisión aparte.
  assert.equal(classifyDeckFamily('lenormand', norm('Rider Waite Lenormand fusion')), null);
  assert.equal(classifyDeckFamily('oraculo', norm('Rider Waite oracle deck')), null);
});

// ── Marsella ──────────────────────────────────────────────────────────────

test('deck_family: Marsella y Marseille', () => {
  assert.equal(classifyDeckFamily('tarot', norm('Tarot de Marsella Clásico 78 Láminas')), 'marsella');
  assert.equal(classifyDeckFamily('tarot', norm('Tarot Marseille French Edition')), 'marsella');
});

// ── Thoth ─────────────────────────────────────────────────────────────────

test('deck_family: Thoth', () => {
  assert.equal(classifyDeckFamily('tarot', norm('Tarot Thoth de Aleister Crowley')), 'thoth');
});

// ── Lenormand no es tarot ────────────────────────────────────────────────

test('primary_type: Lenormand se clasifica como lenormand, nunca como tarot', () => {
  assert.equal(classifyPrimaryType(norm('Mazo Lenormand 36 Cartas Clasico')), 'lenormand');
  assert.equal(classifyPrimaryType(norm('Oraculo Lenormand con Guia')), 'lenormand'); // Lenormand gana aunque diga oráculo
});

test('deck_family no aplica a Lenormand aunque el título mencione "Rider Waite Lenormand"', () => {
  const primaryType = classifyPrimaryType(norm('Lenormand Rider Waite Edition Fusion'));
  assert.equal(primaryType, 'lenormand');
  assert.equal(classifyDeckFamily(primaryType, norm('Lenormand Rider Waite Edition Fusion')), null);
});

// ── Kipper no es tarot ───────────────────────────────────────────────────

test('primary_type: Kipper se clasifica como kipper, nunca como tarot', () => {
  assert.equal(classifyPrimaryType(norm('Baraja Kipper 36 Cartas de Fortuna')), 'kipper');
  assert.equal(classifyPrimaryType(norm('El Tarot Kipper Combo')), 'kipper'); // Kipper se revisa antes que tarot
});

// ── Oracle / Oráculo no es tarot ─────────────────────────────────────────

test('primary_type: oráculo y oracle (con y sin tilde) se clasifican como oraculo', () => {
  assert.equal(classifyPrimaryType(norm('Oráculo de los Ángeles Doreen Virtue')), 'oraculo');
  assert.equal(classifyPrimaryType(norm('Oraculo de las Diosas 44 Cartas')), 'oraculo');
  assert.equal(classifyPrimaryType(norm('Angel Oracle Cards Deck English')), 'oraculo');
});

test('primary_type: un oráculo puro nunca hereda deck_family de tarot', () => {
  const text = norm('Oraculo Rider Waite Style Deck');
  const primaryType = classifyPrimaryType(text);
  assert.equal(primaryType, 'oraculo');
  assert.equal(classifyDeckFamily(primaryType, text), null);
});

// ── Libros SOBRE tarot vs. mazos ─────────────────────────────────────────

test('format: un libro de interpretación de tarot es libro, no mazo', () => {
  assert.equal(classifyFormat('tarot', norm('Guia Completa Para Interpretar El Tarot')), 'libro');
  assert.equal(classifyFormat('tarot', norm('Manual del Tarot: Significados de las Cartas')), 'libro');
});

test('format: un libro que menciona "cartas" en el título sigue siendo libro, no mazo (bug real encontrado en el catálogo)', () => {
  // "Guía para interpretar las cartas" habla DE las cartas; no vende un
  // mazo. La señal fuerte de libro (guia) debe ganar por sobre la mención
  // suelta de "cartas", que por sí sola es ambigua.
  assert.equal(classifyFormat('tarot', norm('Guia Para Interpretar Las Cartas Del Tarot')), 'libro');
});

test('format: patrón real "Libro X, De Autor. Editorial Y" es libro aunque no diga "guía"', () => {
  assert.equal(
    classifyFormat('oraculo', norm('El Oraculo De La Energia Y El Espiritu, De Sandra Anne Taylor. Editorial Guia')),
    'libro',
  );
  assert.equal(
    classifyFormat('oraculo', norm('Libro Las Piedras Ancestrales Oraculo, De Campbell, Rebecca, Vol. 1')),
    'libro',
  );
});

test('format: un mazo con conteo de cartas es mazo incluso si también aparece "libro" (bundle real)', () => {
  assert.equal(
    classifyFormat('tarot', norm('Q&k Light Seers Oracle Tarot Cartas 78 Cartas, guia incluida')),
    'mazo',
  );
});

test('format: "cartas" o "cards" suelta sin ningún signo de libro se asume mazo', () => {
  assert.equal(classifyFormat('tarot', norm('Cartas - The Chakra Wisdom Tarot')), 'mazo');
  assert.equal(classifyFormat('oraculo', norm('Cartas Astro Crush Oraculo Amor Astrologia Cindy Leone')), 'mazo');
});

test('format: un mazo físico de 78 cartas es mazo, no libro, aunque hable de tarot', () => {
  assert.equal(classifyFormat('tarot', norm('Tarot Rider Waite 78 Cartas Original')), 'mazo');
  assert.equal(classifyFormat('tarot', norm('Mazo de Tarot Egipcio')), 'mazo');
});

test('format: mazo + guía incluida sigue siendo mazo (el bundle es un eje aparte)', () => {
  const text = norm('Tarot Rider Waite 78 Cartas + Libro Guia en Español');
  assert.equal(classifyFormat('tarot', text), 'mazo');
  assert.equal(classifyBundle('mazo', text), 'mazo_mas_guia');
});

test('format: sin ninguna señal de libro ni de mazo, queda desconocido', () => {
  assert.equal(classifyFormat('tarot', norm('Tarot Especial Edicion Limitada')), 'desconocido');
});

// ── Mazo + guía / sólo mazo ───────────────────────────────────────────────

test('bundle: variantes de "incluye guía" y "con manual" cuentan como mazo_mas_guia', () => {
  assert.equal(classifyBundle('mazo', norm('Tarot Marsella Incluye Guia De Interpretacion')), 'mazo_mas_guia');
  assert.equal(classifyBundle('mazo', norm('Cartas + Manual En Español')), 'mazo_mas_guia');
});

test('bundle: un mazo sin mención de guía es solo_mazo', () => {
  assert.equal(classifyBundle('mazo', norm('Tarot Thoth 78 Cartas Importado')), 'solo_mazo');
});

test('bundle: desconocido si el format no es mazo', () => {
  assert.equal(classifyBundle('libro', norm('Guia del Tarot')), 'desconocido');
  assert.equal(classifyBundle('desconocido', norm('Tarot')), 'desconocido');
});

// ── Idioma ────────────────────────────────────────────────────────────────

test('idioma: bibliographic.language estructurado tiene prioridad sobre el título', () => {
  const it = item({ title: 'Tarot sin mención de idioma', bibliographic: { language: 'Inglés' } });
  assert.equal(classifyLanguage(it, norm(it.title)), 'ingles');
});

test('idioma: señal de texto cuando no hay dato estructurado', () => {
  assert.equal(classifyLanguage(item(), norm('Tarot Rider Waite en Español con guía')), 'espanol');
  assert.equal(classifyLanguage(item(), norm('Tarot Deck English Version')), 'ingles');
});

test('idioma: bilingüe/multi-idioma explícito', () => {
  assert.equal(classifyLanguage(item(), norm('Tarot Bilingüe Español-Inglés')), 'multilingue');
  assert.equal(classifyLanguage(item(), norm('Tarot en Español e Inglés incluidos')), 'multilingue');
});

test('idioma: sin ninguna señal, desconocido (nunca se asume español por default)', () => {
  assert.equal(classifyLanguage(item(), norm('Tarot Rider Waite 78 Cartas')), 'desconocido');
});

// ── Nivel (principiante / avanzado) ──────────────────────────────────────

test('level: principiante y avanzado con señales claras', () => {
  assert.equal(classifyLevel(norm('Tarot Para Principiantes Guia Basica')), 'principiante');
  assert.equal(classifyLevel(norm('Tarot Avanzado Para Lectores Profesionales')), 'avanzado_profesional');
});

test('level: mención simultánea de ambos queda desconocido, no se fuerza una', () => {
  assert.equal(classifyLevel(norm('Ideal para principiantes y lectores experimentados profesionales')), 'desconocido');
});

// ── Duplicados ────────────────────────────────────────────────────────────

test('dedupeKey: ISBN válido agrupa por sobre título/autor', () => {
  const a = item({ id: 'MLU1', isbn: '9780000000002', title: 'Tarot A', author: 'X' });
  const b = item({ id: 'MLU2', isbn: '9780000000002', title: 'Tarot A (variante)', author: 'Y' });
  assert.equal(dedupeKey(a), dedupeKey(b));
});

test('dedupeKey: sin ISBN, agrupa por título+autor normalizado', () => {
  const a = item({ id: 'MLU1', title: 'Tarot Rider Waite', author: 'US Games' });
  const b = item({ id: 'MLU2', title: '  Tarot Rider Waite  ', author: 'US Games' });
  assert.equal(dedupeKey(a), dedupeKey(b));
});

test('dedupeKey: sin ISBN ni autor, cada id queda solo (no se agrupa por título ambiguo)', () => {
  const a = item({ id: 'MLU1', title: 'Tarot', author: null });
  const b = item({ id: 'MLU2', title: 'Tarot', author: null });
  assert.notEqual(dedupeKey(a), dedupeKey(b));
});

test('buildTarotMerchTags: dos MLU del mismo mazo colapsan a un único producto, activo preferido sobre pausado', () => {
  const { rows } = buildTarotMerchTags({
    activeItems: [item({ id: 'MLU1', title: 'Tarot Rider Waite', author: 'US Games', available_quantity: 3 })],
    pausedItems: [item({ id: 'MLU2', title: 'Tarot Rider Waite', author: 'US Games', status: 'paused' })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].duplicate_mlu_count, 2);
  assert.deepEqual(rows[0].duplicate_mlu_ids.sort(), ['MLU1', 'MLU2']);
});

// ── Accesorios ────────────────────────────────────────────────────────────

test('primary_type: un accesorio real (tapete, bolsa, atril) se distingue del mazo/oráculo que acompaña', () => {
  assert.equal(classifyPrimaryType(norm('Tapete Para Tarot De Terciopelo Negro')), 'accesorio');
  assert.equal(classifyPrimaryType(norm('Bolsa Para Guardar Cartas De Tarot')), 'accesorio');
  assert.equal(classifyPrimaryType(norm('Atril Soporte Para Mazo De Tarot')), 'accesorio');
});

test('primary_type: "estuche" NO es accesorio — es el embalaje del propio mazo (falso positivo real encontrado en el catálogo)', () => {
  // Bug real detectado en la primera corrida: "estuche" describe la caja
  // del mazo, no un accesorio vendido aparte. Ver docs/seo/tarot-merch-tags-audit-*.md.
  assert.equal(classifyPrimaryType(norm('Tarot Egipcio (estuche: 78 Cartas Y Libro) - Arnal Moscardo')), 'tarot');
  assert.equal(classifyPrimaryType(norm('Tarot De Marsella (estuche) - Julian M. White')), 'tarot');
  assert.equal(classifyPrimaryType(norm('Pequeño Oraculo De Los Angeles (55 Cartas) (estuche)')), 'oraculo');
});

// ── Falsos positivos ──────────────────────────────────────────────────────

test('falsos positivos conocidos quedan fuera del universo candidato', () => {
  const { rows } = buildTarotMerchTags({
    activeItems: [
      item({ id: 'MLU1', title: 'Cartas de Amor para San Valentín' }),
      item({ id: 'MLU2', title: 'Juego de Cartas Español 40 Naipes' }),
      item({ id: 'MLU3', title: 'Destino Manifiesto: Historia de EEUU' }),
    ],
  });
  assert.equal(rows.length, 0);
});

test('un ítem con "cartas" en contexto de juego de mesa sin señal esotérica no entra al universo', () => {
  const { rows } = buildTarotMerchTags({
    activeItems: [item({ id: 'MLU1', title: 'Juego de Cartas Truco Uruguayo Tradicional' })],
  });
  assert.equal(rows.length, 0);
});

// ── Datos insuficientes -> desconocido ───────────────────────────────────

test('needsReview: primary_type desconocido dispara revisión', () => {
  // "cartomancia" matchea el universo candidato (otro_sistema), probamos un
  // caso límite que entra por CANDIDATE_RE pero no resuelve ningún sistema
  // específico ni "otro_sistema": mazo de cartas + "adivinat" en el borde.
  const review = needsReview({ primaryType: 'desconocido', format: 'desconocido', text: 'algo ambiguo' });
  assert.equal(review.flag, true);
  assert.match(review.reason, /primary_type desconocido/);
});

test('needsReview: mención de 2+ sistemas distintos dispara revisión', () => {
  const review = needsReview({ primaryType: 'tarot', format: 'mazo', text: norm('Combo Tarot y Oraculo de los Angeles') });
  assert.equal(review.flag, true);
  assert.match(review.reason, /2 o más sistemas/);
});

test('needsReview: format desconocido en un sistema identificado también dispara revisión', () => {
  const review = needsReview({ primaryType: 'tarot', format: 'desconocido', text: norm('Tarot Especial') });
  assert.equal(review.flag, true);
});

test('needsReview: clasificación limpia (sistema + format resueltos, un solo sistema mencionado) no marca revisión', () => {
  const review = needsReview({ primaryType: 'tarot', format: 'mazo', text: norm('Tarot Rider Waite 78 Cartas') });
  assert.equal(review.flag, false);
  assert.equal(review.reason, null);
});

test('classifyItem end-to-end: catálogo con bibliographic null y descripción rica sigue clasificando por texto', () => {
  const it = item({
    id: 'MLU478787120',
    title: "Q&k Light Seer's Oracle Tarot Cartas 78 Cartas, Tarot Cart",
    description: 'Esta baraja y guia de tarot de 78 cartas... ideal para principiantes y lectores experimentados.',
    bibliographic: null,
  });
  const row = classifyItem(it);
  assert.equal(row.primary_type, 'tarot');
  assert.equal(row.format, 'mazo');
  assert.equal(row.bundle, 'mazo_mas_guia');
  assert.equal(row.level, 'desconocido'); // menciona ambos niveles -> no se fuerza
  assert.equal(row.language, 'desconocido');
});

// ── Novedades reales ──────────────────────────────────────────────────────

test('isNewArrival: dentro de la ventana de días es novedad', () => {
  const referenceDate = new Date('2026-08-20T00:00:00.000Z');
  const it = item({ start_time: '2026-08-05T00:00:00.000Z' }); // 15 días atrás
  assert.equal(isNewArrival(it, { referenceDate, windowDays: 30 }), true);
});

test('isNewArrival: fuera de la ventana no es novedad', () => {
  const referenceDate = new Date('2026-08-20T00:00:00.000Z');
  const it = item({ start_time: '2021-04-17T00:00:00.000Z' });
  assert.equal(isNewArrival(it, { referenceDate, windowDays: 30 }), false);
});

test('isNewArrival: sin start_time válido, false (nunca se asume)', () => {
  assert.equal(isNewArrival(item({ start_time: null })), false);
  assert.equal(isNewArrival(item({ start_time: 'fecha-invalida' })), false);
});

// ── Reposición real: sólo con evidencia histórica ────────────────────────

test('detectRestockedIds: sin snapshots previos/actuales del índice pausado, no marca nada (sin evidencia)', () => {
  const result = detectRestockedIds({ previousPausedIds: null, currentPausedIds: null, activeItems: [item({ id: 'MLU1' })] });
  assert.equal(result.size, 0);
});

test('detectRestockedIds: id que salió de pausado y ahora está activo con stock cuenta como reposición real', () => {
  const previousPausedIds = new Set(['MLU1', 'MLU2']);
  const currentPausedIds = new Set(['MLU2']); // MLU1 ya no está pausado
  const activeItems = [item({ id: 'MLU1', status: 'active', available_quantity: 2 })];
  const result = detectRestockedIds({ previousPausedIds, currentPausedIds, activeItems });
  assert.equal(result.has('MLU1'), true);
  assert.equal(result.size, 1);
});

test('detectRestockedIds: id que salió de pausado pero NO aparece activo (se cerró, no repuso) no cuenta', () => {
  const previousPausedIds = new Set(['MLU1']);
  const currentPausedIds = new Set([]);
  const result = detectRestockedIds({ previousPausedIds, currentPausedIds, activeItems: [] });
  assert.equal(result.size, 0);
});

// ── buildTarotMerchTags: reproducibilidad y contrato general ────────────

test('buildTarotMerchTags es determinista: mismo input, mismo output', () => {
  const input = {
    activeItems: [
      item({ id: 'MLU1', title: 'Tarot Rider Waite 78 Cartas', available_quantity: 3 }),
      item({ id: 'MLU2', title: 'Oraculo de los Angeles 44 Cartas' }),
    ],
    pausedItems: [item({ id: 'MLU3', title: 'Lenormand 36 Cartas', status: 'paused' })],
  };
  const first = buildTarotMerchTags(input);
  const second = buildTarotMerchTags(input);
  assert.deepEqual(first, second);
});

test('buildTarotMerchTags valida tipos de entrada', () => {
  assert.throws(() => buildTarotMerchTags({ activeItems: 'no-array' }), /activeItems debe ser un array/);
  assert.throws(() => buildTarotMerchTags({ pausedItems: 'no-array' }), /pausedItems debe ser un array/);
});

test('el módulo generado expone lookups por id y filtro por tipo/formato', async () => {
  const { rows, counts } = buildTarotMerchTags({
    activeItems: [item({ id: 'MLU1', title: 'Tarot Rider Waite 78 Cartas', available_quantity: 3 })],
  });
  const source = tarotTagsModuleSource({ rows, metadata: { schema_version: 1, generated_at: '2026-01-01T00:00:00.000Z', ...counts } });
  assert.match(source, /^\/\/ Archivo generado por scripts\/seo\/generate-tarot-merch-tags\.mjs\./);
  const dataUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const mod = await import(dataUrl);
  assert.equal(mod.tarotTagForId('MLU1').primary_type, 'tarot');
  assert.equal(mod.tarotTagsMatching({ primaryType: 'tarot' }).length, 1);
  assert.equal(mod.tarotTagsMatching({ primaryType: 'oraculo' }).length, 0);
  assert.ok(Object.isFrozen(mod.TAROT_MERCH_TAGS));
});
