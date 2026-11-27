// Paso 2 de Ficha técnica: conseguir el dato faltante por ISBN, en el orden que fijó Seba (27/11/2026):
//   1) base propia verificada de Amado (registro de fichas del repo);
//   2) distribuidores (Arnoia y Celesa, archivos del repo privado);
//   3) fuentes bibliográficas públicas (Open Library y Google Books; sólo viaja el ISBN).
// Nunca se inventa ni se estima: un dato sólo se usa si una fuente lo trae explícito.
// Si dos fuentes se contradicen, vale la de mayor prioridad y la contradicción se anota.
// El catálogo de la web no cuenta como fuente: es una copia de lo que ya está en Mercado Libre.
import { readFileSync, existsSync } from 'node:fs';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import { join } from 'node:path';
import { comparisonKey, coverFromFormat, defaultCacheDir, extractYear, lookupIsbns, normalizeGtinIsbn } from '../../scripts/mercadolibre/isbn-public-sources.mjs';

export const ORDEN = Object.freeze(['registro', 'arnoia', 'celesa', 'openlibrary', 'googlebooks']);

// Atributo de Mercado Libre <- campo de las fuentes.
export const CAMPOS = Object.freeze({
  PUBLICATION_YEAR: 'year',
  LANGUAGE: 'language',
  BOOK_PUBLISHER: 'publisher',
  PAGES_NUMBER: 'pages',
  BOOK_EDITION: 'edition',
  BOOK_COVER: 'cover',
  BOOK_GENRE: 'genre',
  AUTHOR: 'author',
  BOOK_COLLECTION: 'collection',
  BOOK_SERIE: 'collection',
  BOOK_SUBTITLE: 'subtitle',
});

const limpio = v => String(v ?? '').replace(/\s+/g, ' ').trim();
const pag = v => { const n = Number(v); return Number.isInteger(n) && n > 0 && n < 20000 ? String(n) : null; };

// Registro verificado de fichas -> campos. Función pura.
export function desdeRegistro(rec) {
  const f = rec?.facts ?? {}, b = f.bibliographic ?? {};
  return { year: extractYear(b.publication_year) ?? null, language: limpio(b.language) || null, publisher: limpio(f.publisher) || null, pages: pag(f.pages),
    edition: limpio(b.edition) || null, cover: coverFromFormat(b.format), genre: limpio(b.genre) || null, author: limpio(f.author ?? b.author) || null,
    collection: limpio(b.collection) || null, subtitle: limpio(b.subtitle) || null };
}

// Arnoia: editorial, encuadernación y fecha de edición. Función pura.
export function desdeArnoia(x) {
  if (!x) return null;
  return { year: extractYear(x.fecha_edicion) ?? null, publisher: limpio(x.editorial) || null, cover: coverFromFormat(x.encuadernacion), pages: pag(x.paginas) };
}

// Celesa: encuadernación y páginas. Función pura.
export function desdeCelesa(x) {
  if (!x) return null;
  return { cover: coverFromFormat(x.encuadernacion), pages: pag(x.paginas), publisher: limpio(x.editorial) || null, year: extractYear(x.fecha_edicion) ?? null };
}

// Subtítulo, serie y autor desde la respuesta cruda de Open Library (edición) y Google Books. Función pura.
export function extrasOpenLibrary(body) {
  if (!body || typeof body !== 'object') return {};
  const series = (Array.isArray(body.series) ? body.series : []).map(limpio).filter(Boolean);
  return { subtitle: limpio(body.subtitle) || null, collection: series.length === 1 ? series[0] : null };
}
export function extrasGoogle(body, isbn) {
  const items = (Array.isArray(body?.items) ? body.items : []).filter(it => (it?.volumeInfo?.industryIdentifiers ?? []).some(x => normalizeGtinIsbn(x?.identifier) === isbn));
  if (items.length !== 1) return {};
  const v = items[0].volumeInfo ?? {};
  return { subtitle: limpio(v.subtitle) || null, author: Array.isArray(v.authors) && v.authors.length === 1 ? limpio(v.authors[0]) : null };
}

// Decide un campo: vale la fuente de mayor prioridad; si otra dice algo distinto, se anota. Función pura.
export function decidir(campo, porFuente) {
  const hay = ORDEN.map(fuente => ({ fuente, valor: limpio(porFuente?.[fuente]?.[campo]) })).filter(x => x.valor && comparisonKey(campo, x.valor));
  if (!hay.length) return null;
  const elegido = hay[0];
  const distintas = hay.filter(x => comparisonKey(campo, x.valor) !== comparisonKey(campo, elegido.valor));
  return { valor: elegido.valor, fuente: elegido.fuente, coinciden: hay.filter(x => !distintas.includes(x)).map(x => x.fuente), contradicciones: distintas };
}

function leerDistribuidor(ruta) {
  if (!ruta || !existsSync(ruta)) return {};
  try { const j = JSON.parse(readFileSync(ruta, 'utf8')); return j?.items ?? j?.libros ?? Object.fromEntries(Object.entries(j).filter(([k]) => /^\d{10,13}$/.test(k))); } catch { return {}; }
}

export function crearFuentes({ arnoia = process.env.FICHA_ARNOIA, celesa = process.env.FICHA_CELESA, cacheDir = process.env.ISBN_SOURCES_CACHE || defaultCacheDir() } = {}) {
  const registro = new Map();
  for (const r of listBookEnrichments()) { const i = normalizeGtinIsbn(r.isbn); if (i) registro.set(i, r); }
  const ar = leerDistribuidor(arnoia), ce = leerDistribuidor(celesa);
  const estadisticas = { registro: registro.size, arnoia: Object.keys(ar).length, celesa: Object.keys(ce).length, publicas: null };
  return {
    estadisticas,
    // Devuelve Map(isbn -> { registro, arnoia, celesa, openlibrary, googlebooks }).
    async buscar(isbns, { publicas = true } = {}) {
      const out = new Map();
      for (const isbn of isbns) out.set(isbn, { registro: registro.has(isbn) ? desdeRegistro(registro.get(isbn)) : null, arnoia: desdeArnoia(ar[isbn]), celesa: desdeCelesa(ce[isbn]), openlibrary: null, googlebooks: null });
      if (publicas && isbns.length) {
        const r = await lookupIsbns(isbns, { limit: isbns.length, cacheDir });
        estadisticas.publicas = r.stats;
        for (const [isbn, e] of r.byIsbn) { const o = out.get(isbn); if (o) { o.openlibrary = e.openlibrary ?? null; o.googlebooks = e.googlebooks ?? null; } }
        const crudo = (fuente, isbn) => { try { const c = JSON.parse(readFileSync(join(cacheDir, fuente, `${isbn}.json`), 'utf8')); return c?.status === 200 ? c.body : null; } catch { return null; } };
        for (const isbn of isbns) {
          const o = out.get(isbn);
          const ol = extrasOpenLibrary(crudo('openlibrary', isbn)), gb = extrasGoogle(crudo('googlebooks', isbn), isbn);
          if (Object.values(ol).some(Boolean)) o.openlibrary = { ...(o.openlibrary ?? {}), ...ol };
          if (Object.values(gb).some(Boolean)) o.googlebooks = { ...(o.googlebooks ?? {}), ...gb };
        }
      }
      return out;
    },
  };
}
