// CATALOGO-PAGINACION-1 — paginación server-side de /catalogo.
//
// Antes de este lote la página cortaba en 48 resultados sin forma de seguir
// navegando: `/catalogo` mostraba 48 de 17.142 y no existía parámetro de
// página. Estas pruebas cubren el recorte por página, la validación estricta
// de `page`, el orden determinístico y la ausencia de duplicados o saltos
// entre páginas consecutivas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest as catalogRequest } from '../catalogo.js';
import { CATALOG_URL, PAUSED_MANIFEST_URL, PRODUCTION_MANIFEST_URL } from '../_shared/catalog.js';

const PAGE_SIZE = 48;
const TOTAL_ITEMS = 100; // 3 páginas: 48 + 48 + 4

// Títulos deliberadamente NO ordenados por id, para que un orden estable sólo
// pueda venir del desempate explícito y no del azar del array de origen.
function buildCatalog(count = TOTAL_ITEMS) {
  const items = [];
  for (let i = 1; i <= count; i++) {
    items.push({
      id: `MLU${String(i).padStart(4, '0')}`,
      title: `Libro de prueba número ${i}`,
      author: `Autor ${i}`,
      isbn: `978000000${String(i).padStart(4, '0')}`,
      price: 1000 + i,
      status: 'active',
      available_quantity: 1,
      thumbnail: '',
      pictures: [],
      permalink: `https://x/MLU${i}`,
    });
  }
  return { total: items.length, items };
}

let CATALOG = buildCatalog();

function context(url, appEnv = 'test') {
  return {
    request: new Request(url),
    params: {},
    env: { APP_ENV: appEnv },
    waitUntil() {},
  };
}

test.beforeEach(() => {
  CATALOG = buildCatalog();
  globalThis.caches = {
    default: {
      async match(request) {
        if (request.url === CATALOG_URL) return Response.json(CATALOG);
        if (request.url === PAUSED_MANIFEST_URL) return Response.json({ current: null, previous: null });
        if (request.url === PRODUCTION_MANIFEST_URL) return Response.json({ current: null, previous: null });
        return null;
      },
      async put() {},
    },
  };
});

async function render(url, appEnv = 'test') {
  const response = await catalogRequest(context(url, appEnv));
  return { response, html: response.status === 200 ? await response.text() : '' };
}

// Ids de las cards renderizadas, en orden de aparición.
function renderedIds(html) {
  return [...html.matchAll(/\/libro\/(MLU\d+)\//g)].map(m => m[1])
    .filter((id, i, arr) => arr.indexOf(id) === i);
}

const BASE_URL = 'https://www.amadolibros.com/catalogo';

// ── 1. Recorte por página ───────────────────────────────────────────────────

test('1. sin ?page devuelve la primera página y el rango 1–48', async () => {
  const { response, html } = await render(BASE_URL);
  assert.equal(response.status, 200);
  assert.equal(renderedIds(html).length, PAGE_SIZE);
  assert.match(html, /Mostrando 1–48 de 100 resultados\./);
});

test('2. ?page=2 devuelve los resultados 49–96', async () => {
  const { response, html } = await render(`${BASE_URL}?page=2`);
  assert.equal(response.status, 200);
  const ids = renderedIds(html);
  assert.equal(ids.length, PAGE_SIZE);
  assert.match(html, /Mostrando 49–96 de 100 resultados\./);
});

test('3. la última página devuelve solamente el resto', async () => {
  const { response, html } = await render(`${BASE_URL}?page=3`);
  assert.equal(response.status, 200);
  assert.equal(renderedIds(html).length, 4);
  assert.match(html, /Mostrando 97–100 de 100 resultados\./);
  // Sin "Siguiente" navegable en el último extremo.
  assert.match(html, /<span class="pg-ctl is-off" aria-disabled="true">Siguiente/);
});

test('4. la primera página no ofrece "Anterior" navegable', async () => {
  const { html } = await render(BASE_URL);
  assert.match(html, /<span class="pg-ctl is-off" aria-disabled="true">‹ Anterior<\/span>/);
});

// ── 2. Validación de `page` ─────────────────────────────────────────────────

test('5. ?page=1 explícito redirige 301 a la URL limpia', async () => {
  const { response } = await render(`${BASE_URL}?page=1`);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/catalogo');
});

for (const bad of ['0', '-3', '2.5', 'abc', '', ' ', '01', '1e2', '+2', '2abc']) {
  test(`6. ?page=${JSON.stringify(bad)} es inválido y redirige 301 a la URL limpia`, async () => {
    const { response } = await render(`${BASE_URL}?page=${encodeURIComponent(bad)}`);
    assert.equal(response.status, 301);
    assert.equal(response.headers.get('Location'), '/catalogo');
  });
}

test('7. ?page repetido toma la primera ocurrencia', async () => {
  const { response, html } = await render(`${BASE_URL}?page=2&page=9`);
  assert.equal(response.status, 200);
  assert.match(html, /Mostrando 49–96 de 100 resultados\./);
});

test('8. un ?page desbordado no llega a Number() y se trata como inválido', async () => {
  const { response } = await render(`${BASE_URL}?page=99999999999999999999`);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/catalogo');
});

test('9. ?page fuera de rango devuelve 404 real', async () => {
  const { response } = await render(`${BASE_URL}?page=400`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Location'), null);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow');
});

test('10. fuera de rango con una sola página también devuelve 404', async () => {
  CATALOG = buildCatalog(10);
  const { response } = await render(`${BASE_URL}?page=5`);
  assert.equal(response.status, 404);
});

// ── 3. Conservación de filtros ──────────────────────────────────────────────

test('11. ?q se conserva en todos los enlaces de paginación', async () => {
  const { response, html } = await render(`${BASE_URL}?q=prueba&page=2`);
  assert.equal(response.status, 200);
  const hrefs = [...html.matchAll(/class="pg-(?:ctl|num)" (?:rel="\w+" )?href="([^"]+)"/g)].map(m => m[1]);
  assert.ok(hrefs.length > 0, 'debe haber enlaces de paginación');
  for (const href of hrefs) assert.match(href, /(\?|&amp;)q=prueba/);
});

test('12. ?q fuera de rango devuelve 404 y no normaliza a otra página', async () => {
  const { response } = await render(`${BASE_URL}?q=prueba&page=400`);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Location'), null);
});

test('13. ?page=1 explícito con q conserva q al redirigir', async () => {
  const { response } = await render(`${BASE_URL}?q=prueba&page=1`);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/catalogo?q=prueba');
});

test('13b. disponibilidad se conserva en la paginación y no crea páginas indexables', async () => {
  const { html } = await render(`${BASE_URL}?disponibilidad=disponibles&page=2`);
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/catalogo">/);
  assert.match(html, /href="\/catalogo\?disponibilidad=disponibles&amp;page=3"/);
});

test('13c. un valor de disponibilidad inválido redirige a la URL limpia', async () => {
  const { response } = await render(`${BASE_URL}?disponibilidad=agotados`);
  assert.equal(response.status, 301);
  assert.equal(response.headers.get('Location'), '/catalogo');
});

test('13d. los tres filtros de disponibilidad son enlaces accesibles con conteos', async () => {
  const { html } = await render(BASE_URL);
  assert.match(html, /aria-label="Filtrar por disponibilidad"/);
  assert.match(html, /aria-current="page">Todos <span>100<\/span>/);
  assert.match(html, />Disponibles ahora <span>100<\/span>/);
  assert.match(html, />Por encargo <span>0<\/span>/);
});

// ── 4. Integridad de la secuencia ───────────────────────────────────────────

test('14. no hay ids duplicados entre páginas consecutivas', async () => {
  const p1 = renderedIds((await render(BASE_URL)).html);
  const p2 = renderedIds((await render(`${BASE_URL}?page=2`)).html);
  const p3 = renderedIds((await render(`${BASE_URL}?page=3`)).html);
  const todos = [...p1, ...p2, ...p3];
  assert.equal(new Set(todos).size, todos.length, 'ninguna página repite un id');
});

test('15. la unión de todas las páginas cubre el catálogo completo, sin saltos', async () => {
  const p1 = renderedIds((await render(BASE_URL)).html);
  const p2 = renderedIds((await render(`${BASE_URL}?page=2`)).html);
  const p3 = renderedIds((await render(`${BASE_URL}?page=3`)).html);
  const todos = new Set([...p1, ...p2, ...p3]);
  assert.equal(todos.size, TOTAL_ITEMS);
  for (let i = 1; i <= TOTAL_ITEMS; i++) {
    assert.ok(todos.has(`MLU${String(i).padStart(4, '0')}`), `falta MLU${i}`);
  }
});

test('16. el orden es idéntico con el catálogo de origen barajado', async () => {
  const ordenado = [];
  for (const p of ['', '?page=2', '?page=3']) {
    ordenado.push(...renderedIds((await render(`${BASE_URL}${p}`)).html));
  }

  // Mismo contenido, otro orden en el array de R2 — como haría el sync diario.
  const barajado = buildCatalog();
  barajado.items.reverse();
  CATALOG = barajado;

  const trasBarajar = [];
  for (const p of ['', '?page=2', '?page=3']) {
    trasBarajar.push(...renderedIds((await render(`${BASE_URL}${p}`)).html));
  }

  assert.deepEqual(trasBarajar, ordenado,
    'el desempate por id debe hacer la secuencia reproducible');
});

// ── 5. SEO ──────────────────────────────────────────────────────────────────

test('17. cada página tiene canonical propio y nunca apunta a la página 1', async () => {
  const { html: h1 } = await render(BASE_URL);
  assert.match(h1, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/catalogo">/);

  const { html: h2 } = await render(`${BASE_URL}?page=2`);
  assert.match(h2, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/catalogo\?page=2">/);
  assert.doesNotMatch(h2, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/catalogo">/);
});

test('18. una búsqueda paginada es noindex, follow y canonicaliza al catálogo limpio', async () => {
  const { html } = await render(`${BASE_URL}?q=prueba&page=2`);
  assert.match(html, /<meta name="robots" content="noindex, follow">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/www\.amadolibros\.com\/catalogo">/);
});

test('19. el catálogo sin filtros sigue siendo index, follow en cualquier página', async () => {
  const { html } = await render(`${BASE_URL}?page=2`);
  assert.match(html, /<meta name="robots" content="index, follow">/);
});

test('19b. la portada del catálogo comunica disponibles y encargos sin duplicar la home', async () => {
  const { html } = await render(BASE_URL);
  assert.match(html, /<title>Comprar libros disponibles y por encargo \| Amado Libros<\/title>/);
  assert.match(html, /<h1>Libros disponibles y por encargo<\/h1>/);
  assert.match(html, /100 libros disponibles y 0 por encargo en Uruguay/);
  assert.match(html, /ediciones agotadas e importadas de Europa/);
});

test('19c. cada página limpia tiene title, H1, descripción y schema propios', async () => {
  const { html } = await render(`${BASE_URL}?page=2`);
  assert.match(html, /<title>Catálogo de libros — Página 2 \| Amado Libros<\/title>/);
  assert.match(html, /<h1>Libros disponibles y por encargo — Página 2<\/h1>/);
  assert.match(html, /Página 2 de 3 del catálogo de Amado Libros/);
  assert.match(html, /"url":"https:\/\/www\.amadolibros\.com\/catalogo\?page=2"/);
});

// ── 6. Marcado y accesibilidad ──────────────────────────────────────────────

test('20. la navegación son enlaces HTML reales, sin JavaScript', async () => {
  const { html } = await render(`${BASE_URL}?page=2`);
  const nav = html.slice(html.indexOf('<nav class="pg"'));
  assert.match(nav, /<a class="pg-ctl" rel="prev" href="\/catalogo" aria-label="Ir a la página anterior">/);
  assert.match(nav, /<a class="pg-ctl" rel="next" href="\/catalogo\?page=3" aria-label="Ir a la página siguiente">/);
  assert.doesNotMatch(nav, /onclick=|javascript:/);
});

test('21. la paginación se anuncia como nav y marca la página actual', async () => {
  const { html } = await render(`${BASE_URL}?page=2`);
  assert.match(html, /<nav class="pg" aria-label="Paginación de resultados">/);
  assert.match(html, /<span class="pg-num is-current" aria-current="page">2<\/span>/);
});

test('22. hay dos filas: control principal y números', async () => {
  const { html } = await render(`${BASE_URL}?page=2`);
  assert.match(html, /<div class="pg-row pg-main">/);
  assert.match(html, /<div class="pg-row pg-nums">/);
  assert.match(html, /<span class="pg-status">Página 2 de 3<\/span>/);
});

test('23. la ventana ofrece primera y última página', async () => {
  CATALOG = buildCatalog(48 * 20); // 20 páginas
  const { html } = await render(`${BASE_URL}?page=10`);
  assert.match(html, /aria-label="Ir a la primera página">1</);
  assert.match(html, /aria-label="Ir a la última página, 20">20</);
  // Ventana acotada: 1 … 9 [10] 11 … 20 = 7 celdas como máximo.
  const celdas = [...html.matchAll(/class="pg-(?:num|gap)"/g)].length;
  assert.ok(celdas <= 7, `la ventana no debe superar 7 celdas, fueron ${celdas}`);
});

test('24. los controles declaran alto y ancho mínimo de 44 px', async () => {
  const { html } = await render(`${BASE_URL}?page=2`);
  assert.match(html, /\.pg-ctl,\.pg-num,\.pg-gap\{min-width:44px;min-height:44px;/);
});

test('25. con una sola página no se renderiza la navegación', async () => {
  CATALOG = buildCatalog(10);
  const { html } = await render(BASE_URL);
  assert.doesNotMatch(html, /<nav class="pg"/);
  assert.match(html, /10 resultados\./);
});

test('26. sin resultados no hay paginación ni contador de rango', async () => {
  const { html } = await render(`${BASE_URL}?q=zzzqqxyw123`);
  assert.match(html, /No encontramos resultados\./);
  assert.doesNotMatch(html, /<nav class="pg"/);
});
