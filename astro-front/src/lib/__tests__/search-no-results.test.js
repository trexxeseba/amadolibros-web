// Mide el archivo real que se sirve. La regla que defiende, y que salió de la
// revisión externa: NO emitir un evento de búsqueda propio, porque GA4 ya
// dispara view_search_results solo cuando ve ?q= en la URL —parámetro por
// defecto de la Medición mejorada—. Lo único que se emite es lo que GA4 no
// trae: que la búsqueda no encontró nada.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

const FUENTE = readFileSync(
  fileURLToPath(new URL('../../../public/analytics-events.js', import.meta.url)),
  'utf8',
);

function almacenamiento() {
  const datos = new Map();
  return {
    getItem: k => (datos.has(k) ? datos.get(k) : null),
    setItem: (k, v) => datos.set(k, String(v)),
  };
}

// Simula el <p class="sub" data-search-*> que ahora emite catalogo.js.
function cargar({ term = null, results = 0, filtered = false } = {}) {
  const gtagCalls = [];
  const nodo = term === null ? null : {
    getAttribute(nombre) {
      if (nombre === 'data-search-term') return term;
      if (nombre === 'data-search-results') return String(results);
      if (nombre === 'data-search-filtered') return filtered ? '1' : null;
      return null;
    },
  };

  const documento = {
    readyState: 'complete',
    head: { appendChild() {} },
    querySelector: sel => (sel === '[data-search-term]' ? nodo : null),
    getElementById: () => null,
    createElement: () => ({ set src(_v) {}, get src() { return ''; } }),
    addEventListener() {},
  };
  const ventana = {
    location: {
      hostname: 'www.amadolibros.com',
      href: 'https://www.amadolibros.com/catalogo?q=algo',
      pathname: '/catalogo',
    },
    document: documento,
    localStorage: almacenamiento(),
    sessionStorage: almacenamiento(),
    MutationObserver: function () { this.observe = () => {}; },
    setTimeout: () => 0,
    clearTimeout: () => {},
    gtag: (...args) => gtagCalls.push(args),
  };

  runInContext(FUENTE, createContext({ window: ventana, document: documento, console, URL }));
  return { api: ventana.AmadoAnalytics, gtagCalls };
}

const eventos = calls => calls.filter(c => c[0] === 'event');

test('una búsqueda sin resultados queda registrada con el término', () => {
  const { gtagCalls } = cargar({ term: 'frena tu cabeza mammoliti', results: 0 });

  const evento = eventos(gtagCalls).find(c => c[1] === 'search_no_results');
  assert.ok(evento, 'se emite el evento al cargar la página');
  assert.equal(evento[2].search_term, 'frena tu cabeza mammoliti');
  assert.equal(evento[2].has_filters, false);
});

test('nunca se emite un evento de búsqueda propio: GA4 ya lo dispara solo', () => {
  const { gtagCalls } = cargar({ term: 'carl jung', results: 12 });

  const nombres = eventos(gtagCalls).map(c => c[1]);
  assert.ok(!nombres.includes('search'), 'sin evento search propio');
  assert.ok(!nombres.includes('view_search_results'), 'sin duplicar el de GA4');
  assert.ok(!nombres.includes('search_no_results'), 'con resultados no hay nada que avisar');
});

test('distingue cero resultados con filtros de cero sin filtros', () => {
  // Cero con un filtro puesto puede ser una categoría mal elegida, no un libro
  // que falte. Sin este dato se compra stock por un error de navegación.
  const { gtagCalls } = cargar({ term: 'biblia', results: 0, filtered: true });

  const evento = eventos(gtagCalls).find(c => c[1] === 'search_no_results');
  assert.equal(evento[2].has_filters, true);
});

test('una búsqueda que arrastra un dato personal se descarta entera', () => {
  for (const termino of ['pedido de juan@gmail.com', 'llamar al 099841325']) {
    const { gtagCalls } = cargar({ term: termino, results: 0 });
    assert.equal(
      eventos(gtagCalls).filter(c => c[1] === 'search_no_results').length,
      0,
      'no se manda ni una versión "limpiada": ' + termino,
    );
  }
});

test('en una página sin búsqueda no se emite nada', () => {
  const { gtagCalls } = cargar({ term: null });
  assert.equal(eventos(gtagCalls).filter(c => c[1] === 'search_no_results').length, 0);
});
