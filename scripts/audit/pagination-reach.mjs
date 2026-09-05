#!/usr/bin/env node
// 1.4 — LA PREGUNTA CENTRAL.
//
// El 9/8 se desplegó paginación crawleable: /catalogo?page=N y /libros/{cat}?page=N.
// El 25/8 Ahrefs reporta 580 fichas activas con 0 inlinks. Si la paginación
// funciona, esas dos cosas no pueden ser ciertas a la vez.
//
// Método: recorrido en anchura desde la home siguiendo ÚNICAMENTE <a href>
// presentes en el HTML servido (nunca el DOM hidratado por JS), registrando la
// profundidad de clic de cada página. Para cada ficha encontrada se guarda la
// primera página que la enlaza y a cuántos clicks de la home quedó.
//
// Con ese grafo se responden las tres hipótesis del brief con datos:
//   H1 profundidad de clic  — aparece, pero muy profunda;
//   H2 cobertura incompleta — no aparece en ninguna página de paginación;
//   H3 links no rastreables — la paginación no son <a href> reales.
//
// NO implementa ningún sistema de enlazado interno.
import { readFileSync } from 'node:fs';
import { BASE_URL, decodeHtml, paginationVerdict, request, writeReport } from './_lib.mjs';

const CSV_PATH = process.env.AUDIT_ORPHAN_CSV || 'scripts/audit/fixtures/huerfanas-ahrefs-25ago2026.csv';
const SAMPLE = Number(process.env.AUDIT_PAGINATION_SAMPLE) || 15;
const MAX_PAGES = Number(process.env.AUDIT_MAX_PAGES) || 1500;

const origin = new URL(BASE_URL).origin;

function bookId(value) {
  const match = String(value).match(/\/libro\/(MLU\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

// Solo <a href>. Si un link de paginación se pinta por JS, este extractor no lo
// ve — y esa ceguera deliberada es justamente la prueba de la hipótesis 3.
function anchorHrefs(html, pageUrl) {
  const hrefs = [];
  for (const match of html.matchAll(/<a\b[^>]*?\shref=["']([^"']+)["'][^>]*>/gi)) {
    try {
      const url = new URL(decodeHtml(match[1]), pageUrl);
      if (url.origin !== origin) continue;
      url.hash = '';
      hrefs.push(url);
    } catch { /* href inválido: se ignora */ }
  }
  return hrefs;
}

// Superficies que se siguen para el recorrido. No se entra a fichas: lo que se
// mide es qué enlaza a una ficha, no qué enlaza una ficha.
function isCrawlable(url) {
  const p = url.pathname;
  if (/\/libro\//i.test(p)) return false;
  return p === '/'
    || p === '/catalogo'
    || /^\/libros(\/|$)/i.test(p)
    || /^\/especialidades(\/|$)/i.test(p)
    || /^\/libros-/i.test(p);
}

function isPagination(url) {
  return url.searchParams.has('page');
}

async function main() {
  let orphanUrls = [];
  try {
    const csv = readFileSync(CSV_PATH, 'utf8');
    orphanUrls = csv.split(/\r?\n/).slice(1)
      .map(line => (line.match(/https?:\/\/[^"\t]+\/libro\/MLU\d+[^"\t]*/i) || [])[0])
      .filter(Boolean);
  } catch (error) {
    console.error(`No se pudo leer el CSV de huérfanas (${CSV_PATH}): ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const orphanIds = [...new Set(orphanUrls.map(bookId).filter(Boolean))];
  console.log(`Huérfanas declaradas por Ahrefs: ${orphanIds.length}`);

  // Muestra determinista por paso fijo: reproducible, sin depender del azar.
  const step = Math.max(1, Math.floor(orphanIds.length / SAMPLE));
  const sampled = Array.from({ length: Math.min(SAMPLE, orphanIds.length) }, (_, i) => orphanIds[i * step]);

  const depth = new Map([[`${BASE_URL}/`, 0]]);
  const queue = [new URL('/', BASE_URL)];
  const visited = new Set();
  const firstSeen = new Map();   // bookId -> { page, depth }
  const pages = [];
  let anchorPaginationLinks = 0;

  while (queue.length && visited.size < MAX_PAGES) {
    const pageUrl = queue.shift();
    const key = pageUrl.toString();
    if (visited.has(key)) continue;
    visited.add(key);
    const currentDepth = depth.get(key) ?? 0;

    const response = await request(key);
    if (!response.ok || response.status !== 200) {
      pages.push({ url: key, depth: currentDepth, status: response.status, bookLinks: 0, paginationLinks: 0 });
      continue;
    }

    const hrefs = anchorHrefs(response.body, pageUrl);
    let bookLinks = 0;
    let paginationLinks = 0;

    for (const href of hrefs) {
      const id = bookId(href);
      if (id) {
        bookLinks += 1;
        if (!firstSeen.has(id)) firstSeen.set(id, { page: key, depth: currentDepth });
        continue;
      }
      if (!isCrawlable(href)) continue;
      if (isPagination(href)) { paginationLinks += 1; anchorPaginationLinks += 1; }
      const childKey = href.toString();
      if (!depth.has(childKey)) {
        depth.set(childKey, currentDepth + 1);
        queue.push(href);
      }
    }

    pages.push({ url: key, depth: currentDepth, status: 200, bookLinks, paginationLinks });
  }

  const truncated = queue.length > 0;
  console.log(`Páginas recorridas: ${visited.size}${truncated ? ` (CORTADO por AUDIT_MAX_PAGES=${MAX_PAGES}, quedaban ${queue.length})` : ''}`);
  console.log(`Fichas distintas alcanzadas por <a href>: ${firstSeen.size}`);
  console.log(`Links de paginación hallados como <a href> reales: ${anchorPaginationLinks}`);

  const muestra = sampled.map(id => {
    const hit = firstSeen.get(id);
    return {
      bookId: id,
      url: `${BASE_URL}/libro/${id}`,
      aparece: Boolean(hit),
      paginaQueLaEnlaza: hit?.page || null,
      pageParam: hit ? new URL(hit.page).searchParams.get('page') : null,
      clicksDesdeHome: hit ? hit.depth + 1 : null,
    };
  });

  const alcanzadas = orphanIds.filter(id => firstSeen.has(id));
  const noAlcanzadas = orphanIds.filter(id => !firstSeen.has(id));
  const profundidades = alcanzadas.map(id => firstSeen.get(id).depth + 1).sort((a, b) => a - b);
  const percentil = q => (profundidades.length ? profundidades[Math.min(profundidades.length - 1, Math.floor(profundidades.length * q))] : null);

  // Dictamen automático. Se emite solo si el recorrido fue completo: con el
  // recorrido cortado, cualquier "no aparece" es indistinguible de "no llegué".
  const dictamen = paginationVerdict({
    anchorPaginationLinks,
    truncated,
    reachedCount: alcanzadas.length,
    unreachedCount: noAlcanzadas.length,
    medianDepth: percentil(0.5),
  });

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    metodo: 'BFS desde / siguiendo solo <a href> del HTML servido; no se ejecuta JS',
    recorrido: {
      paginasVisitadas: visited.size,
      recorridoCortado: truncated,
      maxPages: MAX_PAGES,
      linksDePaginacionComoAnchorReal: anchorPaginationLinks,
      fichasDistintasAlcanzadas: firstSeen.size,
    },
    huerfanas: {
      declaradasPorAhrefs: orphanIds.length,
      alcanzadasPorPaginacion: alcanzadas.length,
      noAlcanzadas: noAlcanzadas.length,
      profundidadMinima: profundidades[0] ?? null,
      profundidadMediana: percentil(0.5),
      profundidadP90: percentil(0.9),
      profundidadMaxima: profundidades[profundidades.length - 1] ?? null,
    },
    dictamen,
    muestra,
    noAlcanzadas,
    paginas: pages,
  };

  console.log('\n── Muestra de 15 ──');
  for (const row of muestra) {
    console.log(`  ${row.bookId}  ${row.aparece ? `page=${row.pageParam ?? '-'} · ${row.clicksDesdeHome} clicks` : 'NO APARECE'}`);
  }
  console.log(`\nDICTAMEN: ${dictamen}`);
  await writeReport('1.4-pagination-reach.json', report);
}

main().catch(error => {
  console.error(`pagination-reach falló: ${error.message}`);
  process.exitCode = 1;
});
