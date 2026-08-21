// TAROT-HUB-MERCH-1 — selección determinista de módulos merchandising.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTagLookup, buildTarotHubModules } from '../_shared/tarot-hub-modules.js';

function item(id, overrides = {}) {
  return { id, title: `Item ${id}`, price: 1000, available_quantity: 1, ...overrides };
}

function tag(id, overrides = {}) {
  return {
    id,
    primary_type: 'tarot',
    deck_family: null,
    format: 'mazo',
    bundle: 'desconocido',
    level: 'desconocido',
    language: 'desconocido',
    edition_style: null,
    is_new_arrival: false,
    is_restocked: false,
    needs_review: false,
    duplicate_mlu_ids: [id],
    ...overrides,
  };
}

function lookupFrom(tags) {
  return buildTagLookup(tags);
}

test('buildTagLookup resuelve por cualquier MLU duplicado, no sólo por el representante', () => {
  const tags = [tag('MLU1', { duplicate_mlu_ids: ['MLU1', 'MLU2', 'MLU3'] })];
  const lookup = buildTagLookup(tags);
  assert.equal(lookup('MLU1').id, 'MLU1');
  assert.equal(lookup('MLU2').id, 'MLU1');
  assert.equal(lookup('MLU3').id, 'MLU1');
  assert.equal(lookup('MLU9'), null);
});

test('un item sin tag (no clasificado) simplemente no participa de ningún módulo', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: () => null,
  });
  // "Para empezar" siempre está presente como módulo editorial, el resto no.
  assert.equal(modules.length, 1);
  assert.equal(modules[0].id, 'para-empezar');
  assert.equal(modules[0].hasProducts, false);
});

// ── Para empezar: 3-6, o sólo texto ──────────────────────────────────────

test('para-empezar con 3 o más coincidencias muestra hasta 6 productos', () => {
  const items = ['MLU1', 'MLU2', 'MLU3', 'MLU4', 'MLU5', 'MLU6', 'MLU7'].map(id => item(id));
  const tags = items.map(i => tag(i.id, { level: 'principiante' }));
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const paraEmpezar = modules.find(m => m.id === 'para-empezar');
  assert.equal(paraEmpezar.hasProducts, true);
  assert.equal(paraEmpezar.entries.length, 6); // cap en 6, no 7
});

test('para-empezar con exactamente 3 coincidencias muestra los 3', () => {
  const items = ['MLU1', 'MLU2', 'MLU3'].map(id => item(id));
  const tags = items.map(i => tag(i.id, { level: 'principiante' }));
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const paraEmpezar = modules.find(m => m.id === 'para-empezar');
  assert.equal(paraEmpezar.hasProducts, true);
  assert.equal(paraEmpezar.entries.length, 3);
});

test('para-empezar con menos de 3 coincidencias queda sin productos (sólo editorial)', () => {
  const items = ['MLU1', 'MLU2'].map(id => item(id));
  const tags = items.map(i => tag(i.id, { level: 'principiante' }));
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const paraEmpezar = modules.find(m => m.id === 'para-empezar');
  assert.equal(paraEmpezar.hasProducts, false);
  assert.equal(paraEmpezar.entries.length, 0);
});

test('para-empezar sin ninguna coincidencia sigue presente (nunca se elimina el módulo del todo)', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1', { level: 'desconocido' })]),
  });
  const paraEmpezar = modules.find(m => m.id === 'para-empezar');
  assert.ok(paraEmpezar);
  assert.equal(paraEmpezar.hasProducts, false);
});

// ── Módulos que se ocultan completamente si no hay productos ────────────

test('oraculos, clasicos y lenormand-kipper no aparecen si no hay ningún producto que matchee', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1', { primary_type: 'tarot', deck_family: null, format: 'mazo' })]),
  });
  assert.equal(modules.find(m => m.id === 'oraculos'), undefined);
  assert.equal(modules.find(m => m.id === 'clasicos'), undefined);
  assert.equal(modules.find(m => m.id === 'lenormand-kipper'), undefined);
});

test('oraculos aparece cuando hay al menos un oráculo', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1', { primary_type: 'oraculo' })]),
  });
  const oraculos = modules.find(m => m.id === 'oraculos');
  assert.ok(oraculos);
  assert.equal(oraculos.entries.length, 1);
});

test('clasicos agrupa cualquier deck_family (RWS, Marsella, Thoth) en un solo módulo', () => {
  const items = ['MLU1', 'MLU2', 'MLU3'].map(id => item(id));
  const tags = [
    tag('MLU1', { deck_family: 'rider_waite_smith' }),
    tag('MLU2', { deck_family: 'marsella' }),
    tag('MLU3', { deck_family: 'thoth' }),
  ];
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const clasicos = modules.find(m => m.id === 'clasicos');
  assert.equal(clasicos.entries.length, 3);
});

test('lenormand y kipper conviven en un módulo pero cada fila conserva su primary_type real (no se colapsan)', () => {
  const items = ['MLU1', 'MLU2'].map(id => item(id));
  const tags = [tag('MLU1', { primary_type: 'lenormand' }), tag('MLU2', { primary_type: 'kipper' })];
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const module_ = modules.find(m => m.id === 'lenormand-kipper');
  assert.equal(module_.entries.length, 2);
  assert.equal(module_.entries.find(e => e.item.id === 'MLU1').tag.primary_type, 'lenormand');
  assert.equal(module_.entries.find(e => e.item.id === 'MLU2').tag.primary_type, 'kipper');
});

test('para-profundizar sólo incluye format=libro, nunca mazos', () => {
  const items = ['MLU1', 'MLU2'].map(id => item(id));
  const tags = [tag('MLU1', { format: 'libro' }), tag('MLU2', { format: 'mazo' })];
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const paraProfundizar = modules.find(m => m.id === 'para-profundizar');
  assert.equal(paraProfundizar.entries.length, 1);
  assert.equal(paraProfundizar.entries[0].item.id, 'MLU1');
});

test('format=desconocido (36% del universo real) no entra a para-profundizar ni a ningún módulo que requiera formato', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1', { format: 'desconocido', primary_type: 'tarot' })]),
  });
  assert.equal(modules.find(m => m.id === 'para-profundizar'), undefined);
});

// ── Novedades: sólo start_time real ──────────────────────────────────────

test('novedades sólo incluye is_new_arrival=true (ya resuelto en el artefacto por start_time real)', () => {
  const items = ['MLU1', 'MLU2'].map(id => item(id));
  const tags = [tag('MLU1', { is_new_arrival: true }), tag('MLU2', { is_new_arrival: false })];
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const novedades = modules.find(m => m.id === 'novedades');
  assert.equal(novedades.entries.length, 1);
  assert.equal(novedades.entries[0].item.id, 'MLU1');
});

test('sin ninguna novedad real, el módulo no aparece', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1', { is_new_arrival: false })]),
  });
  assert.equal(modules.find(m => m.id === 'novedades'), undefined);
});

// ── Lo más buscado: demanda real de Search Console (impressions/clicks),
// NUNCA opportunity_score — ese campo mide oportunidad SEO/CTR, no volumen
// de búsqueda, y queda reservado para priorización interna. ─────────────

test('sin demandLedgerLookup (DEMAND-LEDGER-1 no mergeado todavía), lo-mas-buscado nunca aparece', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1')]),
    // demandLedgerLookup no provisto -> default siempre null
  });
  assert.equal(modules.find(m => m.id === 'mas-buscado'), undefined);
});

test('muchas impresiones (>= umbral) -> el producto aparece en lo-mas-buscado', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1')]),
    demandLedgerLookup: () => ({ impressions: 50, clicks: 3 }),
  });
  const masBuscado = modules.find(m => m.id === 'mas-buscado');
  assert.ok(masBuscado);
  assert.equal(masBuscado.entries[0].item.id, 'MLU1');
});

test('pocas impresiones (< umbral) -> el producto NO aparece, sin importar los clicks', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1')]),
    demandLedgerLookup: () => ({ impressions: 9, clicks: 8 }), // 9 < 10, por debajo del umbral
  });
  assert.equal(modules.find(m => m.id === 'mas-buscado'), undefined);
});

test('sin evidencia de demanda (demandLedgerLookup devuelve null), tampoco aparece (nunca placeholder)', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1')]),
    demandLedgerLookup: () => null,
  });
  assert.equal(modules.find(m => m.id === 'mas-buscado'), undefined);
});

test('orden por impressions descendente', () => {
  const items = ['MLU1', 'MLU2', 'MLU3'].map(id => item(id));
  const tags = [tag('MLU1'), tag('MLU2'), tag('MLU3')];
  const demand = {
    MLU1: { impressions: 20, clicks: 1 },
    MLU2: { impressions: 80, clicks: 1 },
    MLU3: { impressions: 40, clicks: 1 },
  };
  const modules = buildTarotHubModules({
    items, tagLookup: lookupFrom(tags),
    demandLedgerLookup: id => demand[id] || null,
  });
  const masBuscado = modules.find(m => m.id === 'mas-buscado');
  assert.deepEqual(masBuscado.entries.map(e => e.item.id), ['MLU2', 'MLU3', 'MLU1']);
});

test('empate en impressions -> desempata por clicks descendente', () => {
  const items = ['MLU1', 'MLU2'].map(id => item(id));
  const tags = [tag('MLU1'), tag('MLU2')];
  const demand = {
    MLU1: { impressions: 30, clicks: 2 },
    MLU2: { impressions: 30, clicks: 7 },
  };
  const modules = buildTarotHubModules({
    items, tagLookup: lookupFrom(tags),
    demandLedgerLookup: id => demand[id] || null,
  });
  const masBuscado = modules.find(m => m.id === 'mas-buscado');
  assert.deepEqual(masBuscado.entries.map(e => e.item.id), ['MLU2', 'MLU1']);
});

test('opportunity_score alto con pocas impresiones NO convierte el producto en "más buscado"', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1')]),
    // opportunity_score alto es irrelevante acá: impressions=3 está muy por
    // debajo del umbral de 10, así que el módulo debe quedar ausente.
    demandLedgerLookup: () => ({ impressions: 3, clicks: 0, opportunity_score: 99.9 }),
  });
  assert.equal(modules.find(m => m.id === 'mas-buscado'), undefined);
});

test('con impressions suficientes, un opportunity_score bajo o null no impide que aparezca', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1')]),
    demandLedgerLookup: () => ({ impressions: 25, clicks: 1, opportunity_score: null }),
  });
  const masBuscado = modules.find(m => m.id === 'mas-buscado');
  assert.ok(masBuscado);
  assert.equal(masBuscado.entries[0].item.id, 'MLU1');
});

// ── Volvió a estar disponible: sólo con evidencia histórica real ────────

test('sin ningún is_restocked=true real, el módulo no aparece (nunca se inventa reposición)', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1', { is_restocked: false })]),
  });
  assert.equal(modules.find(m => m.id === 'volvio-disponible'), undefined);
});

test('con evidencia real de reposición, el módulo aparece', () => {
  const modules = buildTarotHubModules({
    items: [item('MLU1')],
    tagLookup: lookupFrom([tag('MLU1', { is_restocked: true })]),
  });
  assert.ok(modules.find(m => m.id === 'volvio-disponible'));
});

// ── Tope por módulo — nunca cargar el universo completo ──────────────────

test('cada módulo con productos respeta el tope de 12 tarjetas aunque haya más candidatos', () => {
  const ids = Array.from({ length: 20 }, (_, i) => `MLU${i + 1}`);
  const items = ids.map(id => item(id));
  const tags = ids.map(id => tag(id, { primary_type: 'oraculo' }));
  const modules = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const oraculos = modules.find(m => m.id === 'oraculos');
  assert.equal(oraculos.entries.length, 12);
  assert.equal(oraculos.totalCount, 20); // el total real se conserva para mostrar "ver más"
});

// ── Validación de entrada y determinismo ─────────────────────────────────

test('buildTarotHubModules valida tipos de entrada', () => {
  assert.throws(() => buildTarotHubModules({ items: 'no-array', tagLookup: () => null }), /items debe ser un array/);
  assert.throws(() => buildTarotHubModules({ items: [], tagLookup: null }), /tagLookup debe ser una función/);
});

test('buildTarotHubModules es determinista', () => {
  const items = ['MLU1', 'MLU2', 'MLU3'].map(id => item(id));
  const tags = [
    tag('MLU1', { primary_type: 'oraculo' }),
    tag('MLU2', { deck_family: 'marsella' }),
    tag('MLU3', { primary_type: 'lenormand' }),
  ];
  const first = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  const second = buildTarotHubModules({ items, tagLookup: lookupFrom(tags) });
  assert.deepEqual(first, second);
});
