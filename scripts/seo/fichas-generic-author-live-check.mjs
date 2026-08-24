#!/usr/bin/env node
// FICHAS-QUALITY-GUARD-1 — verificación HTTP real contra el Preview o
// Producción. Descarga la ficha exacta y /feed.xml y falla si aparece
// cualquier autoría genérica.
//
// Por qué existe: los tests unitarios y de integración corren contra el
// render en memoria. Esta comprobación mira lo que el servidor devuelve de
// verdad por HTTP, que es lo único que ve el cliente y Google. La primera
// versión de esta corrección pasó los tests y falló en el Preview real: este
// script cierra ese hueco.
//
// Uso (en el runner de CI, que sí tiene salida de red):
//   FICHAS_CHECK_BASE_URL=https://pr-246.amadolibros-web.pages.dev \
//   node scripts/seo/fichas-generic-author-live-check.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const BASE_URL = (process.env.FICHAS_CHECK_BASE_URL || 'https://www.amadolibros.com').replace(/\/$/, '');
const OUTPUT_DIR = process.env.FICHAS_CHECK_OUTPUT_DIR || 'artifacts/fichas-quality';
const PRODUCT_ID = process.env.FICHAS_CHECK_PRODUCT_ID || 'MLU724888358';
const PRODUCT_SLUG = process.env.FICHAS_CHECK_PRODUCT_SLUG || 'la-biblia-palabra-de-vida-verbo-divino';

// Autorías genéricas que nunca deben llegar al cliente.
const GENERIC_RE = /desconocid[ao]|unknown\s+author|autor\s+no\s+especificado|sin\s+especificar|varios\s+autores|vv\.?\s*aa\.?/gi;

// Datos que deben seguir presentes: la corrección no puede llevarse nada útil.
const DEBE_CONSERVAR_FICHA = [
  { etiqueta: 'ISBN 9788490739808', re: /9788490739808/ },
  { etiqueta: 'canonical', re: /<link rel="canonical"/ },
  { etiqueta: 'slug en canonical', re: new RegExp(PRODUCT_SLUG) },
  { etiqueta: 'portada por /book-cover/', re: new RegExp(`/book-cover/${PRODUCT_ID}/`) },
];

async function get(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'AmadoLibrosFichasCheck/1.0' } });
  const body = await response.text();
  return { status: response.status, body };
}

function ocurrencias(texto) {
  return [...texto.matchAll(GENERIC_RE)].map(m => m[0]);
}

function contexto(texto, termino) {
  const i = texto.toLowerCase().indexOf(termino.toLowerCase());
  if (i < 0) return null;
  return texto.slice(Math.max(0, i - 90), i + 70).replace(/\s+/g, ' ');
}

async function main() {
  const fichaUrl = `${BASE_URL}/libro/${PRODUCT_ID}/${PRODUCT_SLUG}`;
  const feedUrl = `${BASE_URL}/feed.xml`;
  console.log(`Verificando contra ${BASE_URL}`);

  const [ficha, feed] = await Promise.all([get(fichaUrl), get(feedUrl)]);
  const errores = [];

  // ── Ficha ──────────────────────────────────────────────────────────────
  if (ficha.status !== 200) {
    errores.push(`La ficha respondió HTTP ${ficha.status}: ${fichaUrl}`);
  }
  const enFicha = ocurrencias(ficha.body);
  if (enFicha.length) {
    errores.push(`La ficha contiene ${enFicha.length} aparición(es) de autoría genérica: ${[...new Set(enFicha)].join(', ')}`);
    console.error(`\n  contexto: …${contexto(ficha.body, enFicha[0])}…`);
  }
  for (const { etiqueta, re } of DEBE_CONSERVAR_FICHA) {
    if (!re.test(ficha.body)) errores.push(`La ficha perdió un dato que debía conservar: ${etiqueta}`);
  }

  // ── Feed: sólo el bloque de este producto ──────────────────────────────
  if (feed.status !== 200) {
    errores.push(`/feed.xml respondió HTTP ${feed.status}`);
  }
  const bloque = feed.body
    .split('<item>')
    .find(chunk => chunk.includes(`<g:id>${PRODUCT_ID}</g:id>`));

  if (!bloque) {
    // No es un error en sí: el producto puede quedar fuera del feed por
    // deduplicación por GTIN. Se informa, no se falla.
    console.log(`  ${PRODUCT_ID} no está en /feed.xml (posible deduplicación por GTIN) — no se evalúa.`);
  } else {
    const enFeed = ocurrencias(bloque);
    if (enFeed.length) {
      errores.push(`El bloque de feed de ${PRODUCT_ID} contiene autoría genérica: ${[...new Set(enFeed)].join(', ')}`);
      console.error(`\n  contexto: …${contexto(bloque, enFeed[0])}…`);
    }
    for (const tag of ['g:id', 'g:title', 'g:link', 'g:price', 'g:availability', 'g:image_link']) {
      if (!bloque.includes(`<${tag}>`)) errores.push(`El bloque de feed perdió <${tag}>`);
    }
  }

  const informe = {
    base: BASE_URL,
    productId: PRODUCT_ID,
    fichaUrl,
    fichaStatus: ficha.status,
    aparicionesEnFicha: enFicha.length,
    productoEnFeed: Boolean(bloque),
    aparicionesEnFeed: bloque ? ocurrencias(bloque).length : null,
    errores,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(`${OUTPUT_DIR}/generic-author-live-check.json`, JSON.stringify(informe, null, 2));

  console.log(`\n  ficha  HTTP ${ficha.status} — ${enFicha.length} aparición(es)`);
  console.log(`  feed   HTTP ${feed.status} — ${bloque ? `${ocurrencias(bloque).length} aparición(es) en el bloque` : 'producto ausente'}`);

  if (errores.length) {
    console.error('\nFALLÓ:');
    for (const e of errores) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nOK: ninguna autoría genérica en la ficha ni en el feed; datos preservados.');
}

main().catch(error => {
  console.error(`fichas-generic-author-live-check falló: ${error.message}`);
  process.exitCode = 1;
});
