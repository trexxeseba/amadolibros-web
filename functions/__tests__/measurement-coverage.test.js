// Las páginas que arma un Function de Cloudflare no pasan por BaseLayout.astro,
// así que la medición del sitio no llega sola: hay que incluirla a mano en cada
// una. Eso estuvo mal durante mucho tiempo y no se notaba, porque la ficha de
// libro llama a trackCommerce('view_item', …) dentro de un `if` que pregunta si
// AmadoAnalytics existe — y como no existía, el evento no se disparaba y nadie
// veía un error.
//
// Esta prueba convierte esa regla en algo que se rompe solo: si mañana alguien
// agrega una página nueva con faviconHeadHtml() y se olvida de la medición, acá
// se pone en rojo en vez de descubrirse meses después mirando por qué GA4 no
// tiene vistas de producto.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { measurementHeadHtml } from '../_shared/measurement.js';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

// Páginas de "algo salió mal": no hay conducta de compra que medir y no
// queremos cargar scripts en un camino de error. Se listan con su motivo para
// que excluir una página sea una decisión explícita y no un descuido.
const SIN_MEDICION_A_PROPOSITO = [
  'Catálogo no disponible',      // catalogo.js — fallback cuando no carga el catálogo
  'Volver a libros por encargo', // libros-por-encargo.js — página de error
];

function archivosJs(directorio) {
  const encontrados = [];
  for (const entrada of readdirSync(directorio)) {
    if (entrada === '__tests__' || entrada === 'node_modules') continue;
    const ruta = directorio + entrada;
    if (statSync(ruta).isDirectory()) {
      encontrados.push(...archivosJs(ruta + '/'));
    } else if (entrada.endsWith('.js')) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

test('toda página servida por un Function incluye la medición del sitio', () => {
  const sinMedicion = [];

  for (const ruta of archivosJs(RAIZ)) {
    const contenido = readFileSync(ruta, 'utf8');
    if (!contenido.includes('faviconHeadHtml()')) continue;

    contenido.split('\n').forEach((linea, indice) => {
      if (!linea.includes('${faviconHeadHtml()}')) return;
      if (SIN_MEDICION_A_PROPOSITO.some(marca => linea.includes(marca))) return;
      if (linea.includes('measurementHeadHtml()')) return;
      sinMedicion.push(ruta.slice(RAIZ.length) + ':' + (indice + 1));
    });
  }

  assert.deepEqual(
    sinMedicion,
    [],
    'estas páginas se sirven sin GA4 ni píxel de Meta:\n  ' + sinMedicion.join('\n  '),
  );
});

test('la ficha de libro carga la medición antes de pedirle un evento', () => {
  const ficha = readFileSync(RAIZ + 'libro/[[path]].js', 'utf8');

  const medicion = ficha.indexOf('measurementHeadHtml()');
  const evento = ficha.indexOf("trackCommerce('view_item'");
  assert.ok(medicion > 0, 'la ficha incluye la medición');
  assert.ok(evento > 0, 'la ficha sigue midiendo la vista de producto');
  assert.ok(
    medicion < evento,
    'el script de medición va antes del evento; si no, AmadoAnalytics todavía no existe',
  );
});

test('la medición se sirve sin defer, o el evento de la ficha se pierde', () => {
  const html = measurementHeadHtml();

  assert.equal(html, '<script src="/analytics-events.js"></script>');
  assert.doesNotMatch(
    html,
    /defer|async/,
    'con defer el archivo corre después del <script> inline de la ficha y vuelve el bug',
  );
});
