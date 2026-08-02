// CF-CATEGORÍAS-2C — filtro de categoría/subcategoría + orden por relevancia
// en /catalogo, exclusivo de Preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL, PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL, R2_BASE } from '../_shared/catalog.js';

const CATALOG = {
  total: 5,
  items: [
    {
      id: 'MLU1', title: 'El Género En Disputa', author: 'Judith Butler',
      isbn: '9780415924993', price: 1000, status: 'active', available_quantity: 2,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU1',
    },
    {
      id: 'MLU2', title: 'Tarot De Los Ángeles', author: 'Doreen Virtue',
      isbn: '2', price: 900, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU2',
    },
    {
      id: 'MLU3', title: 'Tarot Egipcio Oráculo Clásico', author: 'Autora Desconocida',
      isbn: '3', price: 800, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU3',
    },
    {
      id: 'MLU4', title: 'Sin categoría conocida', author: 'Nadie Reconocido',
      isbn: '4', price: 500, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU4',
    },
    {
      id: 'MLU5', title: 'Vinilo The Beatles Abbey Road', author: '',
      isbn: '5', price: 700, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU5',
    },
    // Débil/parcial para "eva luna" — MLU7 (pausada, exacta) debe ganarle.
    {
      id: 'MLU8', title: 'Eva Luna Historias De Mujeres Varias', author: 'Otro Autor',
      isbn: '8', price: 600, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU8',
    },
    {
      id: 'MLU9', title: 'Manual De Filosofía Estoica', author: 'Autor Nueve',
      isbn: '9', price: 650, status: 'active', available_quantity: 1,
      thumbnail: '', pictures: [], permalink: 'https://x/MLU9',
    },
  ],
};

const ACTIVE_CATEGORIES = {
  generated_at: '2026-08-02T00:00:00.000Z',
  taxonomy_version: 2,
  rules_version: 8,
  categories: [
    { id: 'filosofia-ciencias-sociales', name: 'Filosofía y ciencias sociales', count: 3, subcategories: [] },
    {
      id: 'esoterismo-tarot', name: 'Esoterismo y tarot', count: 2,
      subcategories: [{ id: 'tarot-oraculos', name: 'Tarot y oráculos', count: 2 }],
    },
    {
      id: 'otros-productos', name: 'Otros productos', count: 1,
      subcategories: [{ id: 'discos-vinilos', name: 'Discos y vinilos', count: 1 }],
    },
    { id: 'idiomas-aprendizaje', name: 'Idiomas y aprendizaje', count: 1, subcategories: [] },
    { id: 'literatura-ficcion', name: 'Literatura y ficción', count: 2, subcategories: [] },
  ],
  items: {
    MLU1: ['filosofia-ciencias-sociales'],
    MLU2: ['esoterismo-tarot', 'tarot-oraculos'],
    MLU3: ['esoterismo-tarot', 'tarot-oraculos'],
    MLU5: ['otros-productos', 'discos-vinilos'],
    MLU6: ['idiomas-aprendizaje'],
    MLU7: ['literatura-ficcion'],
    MLU8: ['literatura-ficcion'],
    MLU9: ['filosofia-ciencias-sociales'],
    MLU10: ['filosofia-ciencias-sociales'],
  },
};

// CF-CATEGORÍAS-2D: fixtures de pausadas (misma forma que expandPausedIndex
// en functions/_shared/catalog.js) — usadas para probar inclusión pública,
// tratamiento comercial ("Disponible por encargo"/"Pedir este libro") y
// desempate de ranking por estado comercial.
const PAUSED_MANIFEST = {
  schema_version: 1,
  current: {
    version: 'v1',
    index_key: 'stock1-preview/index.json',
    block_prefix: 'stock1-preview/blocks',
    block_count: 1,
  },
};

const PAUSED_INDEX = {
  schema_version: 1,
  fields: ['id', 'title', 'author', 'isbn', 'image'],
  derived_fields: { slug: 'slugify-v1', status: 'paused', block: 'numeric-id-mod-block-count' },
  block_count: 1,
  items: [
    ['MLU6', 'Diccionario Inglés Avanzado', 'Autor Encargo', '111', ''],
    // Exacta pausada — debe superar a una débil activa (MLU8) para "eva luna".
    ['MLU7', 'Eva Luna', 'Isabel Allende', '222', ''],
    ['MLU10', 'Ensayo De Filosofía Moderna', 'Autor Encargo Dos', '333', ''],
  ],
};

function context(url, appEnv = 'preview') {
  return {
    request: new Request(url),
    params: {},
    env: { APP_ENV: appEnv },
    waitUntil() {},
  };
}

test.beforeEach(() => {
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === CATALOG_URL) return Response.json(CATALOG);
        // manifestUrlFor() usa PAUSED_MANIFEST_URL en Preview y
        // PRODUCTION_MANIFEST_URL en producción. Preview resuelve al
        // manifest real de pausadas de estos fixtures; producción sigue
        // anulado para forzar fetchCatalog() (mock de arriba) — nunca
        // pausadas en producción en este lote.
        if (request.url === PAUSED_MANIFEST_URL) return Response.json(PAUSED_MANIFEST);
        if (request.url === PRODUCTION_MANIFEST_URL) return Response.json({ current: null, previous: null });
        if (request.url === `${R2_BASE}/${PAUSED_MANIFEST.current.index_key}`) {
          return Response.json(PAUSED_INDEX);
        }
        if (request.url.endsWith('/data/active-categories.json')) {
          return Response.json(ACTIVE_CATEGORIES);
        }
        return null;
      },
      async put() {},
    },
  };
});

test('categoría válida filtra solo esa categoría', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Tarot Egipcio/);
  assert.doesNotMatch(html, /El Género En Disputa/);
  assert.doesNotMatch(html, /Sin categoría conocida/);
});

test('subcategoría válida filtra dentro de la categoría', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /<option value="tarot-oraculos" selected>/);
});

test('subcategoría inválida para la categoría elegida vuelve a "Todas" (no rompe, no excluye todo)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot&subcategoria=no-existe'));
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Tarot Egipcio/);
});

test('subcategoría sin categoría se ignora', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?subcategoria=tarot-oraculos'));
  const html = await res.text();
  // Sin categoria válida, cae en "sin filtro" -> índice completo.
  assert.match(html, /El Género En Disputa/);
});

test('categoría inválida vuelve a "Todos" (sin filtrar, sin error)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=no-existe'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Sin categoría conocida/);
});

test('búsqueda + categoría se combinan (AND, no OR)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Tarot Egipcio/);
  assert.doesNotMatch(html, /El Género En Disputa/);
});

test('búsqueda + categoría + subcategoría se combinan', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
});

test('búsqueda que no matchea la categoría elegida da cero resultados, no ignora la categoría', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=genero&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.doesNotMatch(html, /El Género En Disputa/);
  assert.match(html, /No encontramos resultados/);
});

test('el selector conserva q al elegir categoría (value del input persiste)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /value="tarot"/);
  assert.match(html, /<option value="esoterismo-tarot" selected>/);
});

test('el selector conserva categoria y subcategoria al buscar', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /<option value="esoterismo-tarot" selected>/);
  assert.match(html, /<option value="tarot-oraculos" selected>/);
});

test('"Limpiar filtros" aparece con categoría activa y conserva q', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /Limpiar filtros/);
  assert.match(html, /href="\/catalogo\?q=tarot"/);
});

test('"Limpiar filtros" no aparece sin categoría/subcategoría activa', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot'));
  const html = await res.text();
  assert.doesNotMatch(html, /Limpiar filtros/);
});

test('chips muestran los filtros activos claramente', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot&categoria=esoterismo-tarot&subcategoria=tarot-oraculos'));
  const html = await res.text();
  assert.match(html, /class="filter-chip"[^>]*>[^<]*tarot/i);
  assert.match(html, /Esoterismo y tarot/);
  assert.match(html, /Tarot y oráculos/);
});

test('catálogo sin ningún filtro muestra "Todos" seleccionado y todos los títulos incluidos', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /<option value=""\s*selected>Todos<\/option>/);
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
  assert.match(html, /Sin categoría conocida/);
  assert.match(html, /Vinilo The Beatles/);
});

test('solo aparecen en el selector categorías con libros activos', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /Filosofía y ciencias sociales/);
  assert.match(html, /Esoterismo y tarot/);
  assert.doesNotMatch(html, /Cocina y gastronomía/);
});

test('objetos (otros-productos) quedan visibles en su categoría, no excluidos', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=otros-productos'));
  const html = await res.text();
  assert.match(html, /Vinilo The Beatles/);
});

test('fuera de Preview (producción), los parámetros de categoría se ignoran por completo', async () => {
  const res = await catalogRequest(context('https://www.amadolibros.com/catalogo?categoria=esoterismo-tarot', 'production'));
  const html = await res.text();
  assert.doesNotMatch(html, /<select/);
  assert.match(html, /El Género En Disputa/);
  assert.match(html, /Tarot De Los Ángeles/);
});

test('muestra cantidad de resultados', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html = await res.text();
  assert.match(html, /2 resultados\./);
});

// ── Orden de relevancia (CF-CATEGORÍAS-2C punto 5) ─────────────────────────

test('ISBN exacto aparece primero', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=9780415924993'));
  const html = await res.text();
  const firstCard = html.indexOf('<article class="rc-card');
  assert.ok(firstCard !== -1, 'no se renderizó ninguna card');
  assert.match(html.slice(firstCard, firstCard + 500), /El Género En Disputa/);
});

test('título exacto aparece primero que una coincidencia parcial', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=tarot+de+los+angeles'));
  const html = await res.text();
  const idxExact = html.indexOf('Tarot De Los Ángeles');
  const idxOther = html.indexOf('Tarot Egipcio');
  assert.ok(idxExact !== -1);
  assert.ok(idxOther === -1 || idxExact < idxOther, 'el título exacto debería aparecer antes');
});

test('autor exacto se encuentra y aparece en los resultados', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=judith+butler'));
  const html = await res.text();
  assert.match(html, /El Género En Disputa/);
});

test('normalización de tildes: buscar sin tilde encuentra título con tilde', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=angeles'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
});

test('tolerancia liviana a errores de tipeo (distancia 1) cuando la búsqueda estricta no encuentra nada', async () => {
  // "angelas" en vez de "angeles" — un solo carácter de diferencia.
  const res = await catalogRequest(context('https://preview.example/catalogo?q=angelas'));
  const html = await res.text();
  assert.match(html, /Tarot De Los Ángeles/);
});

test('sin duplicados: cada MLU aparece una sola vez en la grilla', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html = await res.text();
  const count = (html.match(/Tarot De Los Ángeles/g) || []).length;
  assert.equal(count, 1);
});

test('regeneración reproducible: misma request da la misma respuesta', async () => {
  const res1 = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html1 = await res1.text();
  const res2 = await catalogRequest(context('https://preview.example/catalogo?categoria=esoterismo-tarot'));
  const html2 = await res2.text();
  assert.equal(html1, html2);
});

// ── CF-CATEGORÍAS-2D: pausadas visibles, tratamiento comercial, ranking ────

test('ausencia del fallback textual: "Todos" siempre renderiza cards, nunca la lista <ul> de texto', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /<article class="rc-card/);
  assert.match(html, /class="rc-img"/);
  assert.match(html, /class="rc-body"/);
  // La vieja rama de "sin filtro" renderizaba <ul><li><a> en dos columnas —
  // esa estructura no debe volver a aparecer.
  assert.doesNotMatch(html, /<ul>\s*<li>/);
});

test('pausadas visibles públicamente junto a las activas en "Todos"', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  assert.match(html, /Diccionario Inglés Avanzado/);
  assert.match(html, /El Género En Disputa/); // activa, sigue presente
});

test('"Todos" = universo público exacto (activas + pausadas, sin fantasmas)', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo'));
  const html = await res.text();
  const cardCount = (html.match(/<article class="rc-card/g) || []).length;
  assert.equal(cardCount, CATALOG.items.length + PAUSED_INDEX.items.length);
});

test('pausada muestra "Disponible por encargo" y CTA "Pedir este libro", nunca "pausado"/"paused"/needsReview', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=diccionario+ingles'));
  const html = await res.text();
  assert.match(html, /Disponible por encargo/);
  assert.match(html, /Pedir este libro/);
  assert.doesNotMatch(html, /\bpaused\b/i);
  assert.doesNotMatch(html, /\bpausado\b/i);
  assert.doesNotMatch(html, /needsReview/);
  assert.doesNotMatch(html, /confidence/);
});

test('pausada no entra al checkout: sin "Ver ficha", CTA apunta a WhatsApp con mensaje autocompletado', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=diccionario+ingles'));
  const html = await res.text();
  const cardStart = html.indexOf('<article class="rc-card');
  const cardHtml = html.slice(cardStart, html.indexOf('</article>', cardStart) + '</article>'.length);
  assert.match(cardHtml, /Diccionario Inglés Avanzado/);
  assert.doesNotMatch(cardHtml, /Ver ficha/);
  assert.match(cardHtml, /wa\.me/);
  const waHrefMatch = cardHtml.match(/href="([^"]*wa\.me[^"]*)"/);
  assert.ok(waHrefMatch, 'no se encontró el link de WhatsApp');
  const decoded = decodeURIComponent(waHrefMatch[1]);
  assert.match(decoded, /Diccionario Inglés Avanzado/);
  assert.match(decoded, /Autor Encargo/);
  assert.match(decoded, /MLU6/);
});

test('a igual relevancia, la activa aparece antes que la pausada', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?categoria=filosofia-ciencias-sociales'));
  const html = await res.text();
  const idxActive = html.indexOf('Manual De Filosofía Estoica'); // MLU9, activa
  const idxPaused = html.indexOf('Ensayo De Filosofía Moderna'); // MLU10, pausada
  assert.ok(idxActive !== -1 && idxPaused !== -1);
  assert.ok(idxActive < idxPaused, 'la activa debería listarse antes que la pausada en empate de relevancia');
});

test('una coincidencia exacta pausada supera a una coincidencia débil activa', async () => {
  const res = await catalogRequest(context('https://preview.example/catalogo?q=eva+luna'));
  const html = await res.text();
  const idxExactPaused = html.indexOf('>Eva Luna<'); // MLU7, título exacto, pausada
  const idxWeakActive = html.indexOf('Eva Luna Historias De Mujeres Varias'); // MLU8, activa, parcial
  assert.ok(idxExactPaused !== -1 && idxWeakActive !== -1);
  assert.ok(idxExactPaused < idxWeakActive, 'la coincidencia exacta (aunque pausada) debe ir primero');
});

test('fuera de Preview (producción), las pausadas no se incluyen', async () => {
  const res = await catalogRequest(context('https://www.amadolibros.com/catalogo', 'production'));
  const html = await res.text();
  assert.doesNotMatch(html, /Diccionario Inglés Avanzado/);
});
