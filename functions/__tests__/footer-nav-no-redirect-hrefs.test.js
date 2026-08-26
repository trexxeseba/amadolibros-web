// AUDITORIA-EXTERNA-25AGO2026, Bloque 3.
//
// Las nueve paginas estaticas de Astro (como-identificar-edicion-correcta-isbn,
// contacto, devoluciones, envios, pedir-libro, privacidad, quienes-somos,
// terminos, politicas) se compilan en formato "directory"
// (dist/<ruta>/index.html) — confirmado corriendo `npm run build` en
// astro-front y leyendo el arbol emitido, no supuesto. Cloudflare Pages
// responde 308 a la ruta sin barra final antes de servir el destino real.
//
// Este test no hace una peticion HTTP real — no hay forma de reproducir el
// 308 de la plataforma Cloudflare Pages en un test unitario sin desplegar, y
// el brief pide explicitamente no reabrir el frente de performance/red en
// esta tanda. En su lugar valida la CAUSA RAIZ del 3xx directamente: que
// ningun href="..." del footer/nav compartido apunte a una de esas nueve
// rutas sin la barra final. Es la condicion necesaria y suficiente para que
// Cloudflare no emita el redirect.
//
// Alcance deliberadamente acotado a chrome compartido (footer/nav), no a
// cualquier link del sitio: functions/libro/[[path]].js y functions/catalogo.js
// tienen ademas contenido no relacionado (JSON-LD de Merchant en el primero,
// CTAs de busqueda manual en el segundo) que este test NO debe evaluar — ver
// INFORME.md, "decisiones conservadoras", sobre por que esos otros links
// quedan fuera de este Bloque.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const DIRECTORY_FORMAT_ROUTES = Object.freeze([
  'como-identificar-edicion-correcta-isbn',
  'contacto',
  'devoluciones',
  'envios',
  'pedir-libro',
  'privacidad',
  'quienes-somos',
  'terminos',
  'politicas',
]);

// Cada entrada es un archivo de chrome compartido y, opcionalmente, el
// nombre de un marcador de inicio/fin para acotar la busqueda a un bloque
// especifico dentro de un archivo mas grande que tiene otro contenido ajeno
// al footer/nav (JSON-LD, CTAs de busqueda). Sin marcador, se escanea el
// archivo entero.
const CHROME_SOURCES = Object.freeze([
  { file: 'astro-front/src/components/Footer.astro' },
  { file: 'astro-front/src/components/TrustStrip.astro' },
  { file: 'astro-front/src/components/DeliveryCoordination.astro' },
  { file: 'astro-front/src/components/BookDiscovery.astro' },
  { file: 'functions/_shared/brand.js' },
  { file: 'functions/libros-por-encargo.js' },
  // catalogo.js: solo el <footer> minimo, no el CTA "Pedir que lo busquemos"
  // (ese es contenido de busqueda, no nav — mismo criterio que se aplico a
  // los CTAs ?tipo=exacto de Hero.astro/CommercialBenefits.astro, fuera de
  // este Bloque).
  { file: 'functions/catalogo.js', startMarker: '<footer>', endMarker: '</footer>' },
  // libro/[[path]].js: solo la linea del footer de politicas, nunca el
  // bloque JSON-LD (que usa @id con /envios y /devoluciones — identificadores
  // de schema.org de Merchant, terreno explicitamente prohibido en este brief).
  { file: 'functions/libro/[[path]].js', startMarker: 'Ver política de envíos', contextChars: 60 },
]);

function extractHrefTargets(source) {
  // Exige contexto real de atributo href, para no confundir un @id de
  // JSON-LD (`'@id': \`${BASE}/envios#...\``) con un link navegable.
  // matchEnd usa match[0].length real (no un offset fijo adivinado) para
  // saber exactamente donde termina "href=\"/ruta" y poder mirar el
  // caracter siguiente sin depender de cuantos caracteres tiene el prefijo.
  const hits = [];
  for (const match of source.matchAll(/href=["'`]\/?([a-z0-9-]+)/gi)) {
    hits.push({ route: match[1], matchEnd: match.index + match[0].length });
  }
  return hits;
}

function scopedSource(fullSource, entry) {
  if (!entry.startMarker) return fullSource;
  const start = fullSource.indexOf(entry.startMarker);
  if (start === -1) throw new Error(`marcador de inicio no encontrado en ${entry.file}: "${entry.startMarker}"`);
  if (entry.endMarker) {
    const end = fullSource.indexOf(entry.endMarker, start);
    if (end === -1) throw new Error(`marcador de fin no encontrado en ${entry.file}: "${entry.endMarker}"`);
    return fullSource.slice(start, end + entry.endMarker.length);
  }
  const span = entry.contextChars ?? 200;
  return fullSource.slice(Math.max(0, start - span), start + span);
}

test('ningun href del footer/nav compartido apunta a una ruta directory sin barra final', () => {
  const hallazgos = [];
  for (const entry of CHROME_SOURCES) {
    const fullSource = readFileSync(path.join(repoRoot, entry.file), 'utf8');
    const scoped = scopedSource(fullSource, entry);
    for (const hit of extractHrefTargets(scoped)) {
      if (!DIRECTORY_FORMAT_ROUTES.includes(hit.route)) continue;
      // Con barra: el caracter inmediatamente despues de la ruta coincidente
      // es '/'. Sin barra: termina el atributo (comilla) o sigue '?'/'#'.
      const nextChar = scoped[hit.matchEnd];
      if (nextChar === '/') continue; // ya tiene la barra final
      const contexto = scoped.slice(Math.max(0, hit.matchEnd - hit.route.length - 15), hit.matchEnd + 25);
      hallazgos.push(`${entry.file}: /${hit.route} sin barra final — "...${contexto}..."`);
    }
  }
  assert.deepEqual(hallazgos, [], `hrefs que producirian 308 en Cloudflare Pages:\n  ${hallazgos.join('\n  ')}`);
});

test('el build de Astro sigue emitiendo estas nueve rutas en formato directory (documenta la causa raiz)', () => {
  // No falla si cambia el formato de build — documenta el supuesto sobre el
  // que se apoya el test anterior. Si el build pasara a formato "file"
  // (dist/<ruta>.html), el 308 deja de existir y este archivo queda
  // obsoleto: ese es el aviso que deja este test.
  const distDir = path.join(repoRoot, 'astro-front', 'dist');
  let existeDist = false;
  try { existeDist = statSync(distDir).isDirectory(); } catch { /* no se corrio build en este entorno */ }
  if (!existeDist) return;
  for (const route of DIRECTORY_FORMAT_ROUTES) {
    const indexPath = path.join(distDir, route, 'index.html');
    let emitidoComoDirectorio = false;
    try { emitidoComoDirectorio = statSync(indexPath).isFile(); } catch { /* no emitido asi */ }
    assert.ok(emitidoComoDirectorio, `se esperaba dist/${route}/index.html (formato directory) — si esto cambio, el fix del Bloque 3 puede haber quedado obsoleto`);
  }
});
