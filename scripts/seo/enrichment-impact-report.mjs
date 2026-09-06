import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { applyBookEnrichment } from '../../functions/_shared/book-enrichment-registry.js';
import { isGenericAuthor, normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';

// Informe de impacto por FICHA, no por ISBN.
//
// Una edición (ISBN) puede cubrir varias publicaciones (MLU), y son las
// publicaciones las que se ven en el sitio. "Investigar 1.000 ISBN" no es
// "mejorar 1.000 fichas", así que este informe separa las tres cifras:
//
//   - ISBN investigados   → los que se consultaron contra las fuentes;
//   - ISBN incorporados   → los que entraron al registro con evidencia;
//   - fichas beneficiadas → publicaciones activas que ganan al menos un dato.
//
// El "antes" es la ficha EFECTIVA sin los hechos del lote medido, es decir lo
// que ya se publicaba. Así un dato que la ficha ya tenía no se cuenta dos
// veces.

const R2_BASE = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev';
const CATALOG_URL = `${R2_BASE}/catalog.json`;

export const EDITION_FIELDS = Object.freeze([
  'author', 'publisher', 'pages', 'language', 'format', 'edition', 'publication_year', 'topics',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function existingFact(item, field) {
  const bib = item?.bibliographic && typeof item.bibliographic === 'object' ? item.bibliographic : {};
  if (field === 'author') return isGenericAuthor(item?.author) ? null : clean(item?.author) || null;
  if (field === 'publisher') return clean(item?.publisher) || null;
  if (field === 'pages') return Number(item?.pages) > 0 ? Number(item.pages) : null;
  if (field === 'topics') {
    return Array.isArray(bib.subjects) && bib.subjects.some(clean) ? bib.subjects.filter(clean) : null;
  }
  return clean(bib[field]) || null;
}

// Reconstruye la ficha tal como se publicaba antes de este lote.
export function withoutLoteFacts(effective, record) {
  if (!record) return effective;
  const facts = record.facts || {};
  const bibliographic = { ...(effective.bibliographic || {}) };
  for (const key of Object.keys(facts.bibliographic || {})) delete bibliographic[key];
  const before = { ...effective, bibliographic };
  if (facts.author) before.author = null;
  if (facts.publisher) before.publisher = null;
  if (facts.pages) before.pages = null;
  return before;
}

export function gainedFields(before, after) {
  return EDITION_FIELDS.filter(field => !existingFact(before, field) && Boolean(existingFact(after, field)));
}

export function buildFieldTable(fichas) {
  const table = {};
  for (const field of EDITION_FIELDS) {
    const antes = fichas.filter(f => f.antes.includes(field)).length;
    const despues = fichas.filter(f => f.despues.includes(field)).length;
    table[field] = { antes, despues, mas_fichas: despues - antes };
  }
  return table;
}

export function summarizeFichas(fichas) {
  return {
    fichas_evaluadas: fichas.length,
    sin_mejora: fichas.filter(f => f.ganados.length === 0).length,
    con_1_o_mas: fichas.filter(f => f.ganados.length >= 1).length,
    con_3_o_mas: fichas.filter(f => f.ganados.length >= 3).length,
  };
}

export async function main() {
  const outputDir = process.env.SEO_OUTPUT_DIR || 'artifacts/seo';
  // Acepta varios módulos separados por coma: el impacto acumulado de todos
  // los lotes es lo que se compara contra la meta, no el de uno solo.
  const modulePaths = String(process.env.LOTE_MODULE || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!modulePaths.length) throw new Error('Falta LOTE_MODULE con el módulo de hechos a medir.');
  const investigatedRaw = Number(process.env.ISBN_INVESTIGADOS);
  const investigated = Number.isFinite(investigatedRaw) ? investigatedRaw : null;

  // Si un ISBN aparece en más de un lote, sus hechos se combinan para medir:
  // la ficha publicada los recibe todos.
  const loteByIsbn = new Map();
  let registrosDeLote = 0;
  for (const modulePath of modulePaths) {
    const { BOOK_FACT_ENRICHMENTS: lote } = await import(pathToFileURL(path.resolve(modulePath)).href);
    registrosDeLote += lote.length;
    for (const record of lote) {
      const previo = loteByIsbn.get(record.isbn);
      loteByIsbn.set(record.isbn, previo
        ? {
            ...previo,
            facts: {
              ...previo.facts,
              ...record.facts,
              bibliographic: { ...(previo.facts?.bibliographic || {}), ...(record.facts?.bibliographic || {}) },
            },
          }
        : record);
    }
  }
  const lote = [...loteByIsbn.values()];

  const fetchedAt = new Date().toISOString();
  const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`catalog.json respondió HTTP ${response.status}`);
  const catalog = await response.json();

  const activos = (Array.isArray(catalog?.items) ? catalog.items : [])
    .filter(item => item?.status === 'active' && Number(item.available_quantity) > 0);

  const fichas = [];
  for (const item of activos) {
    const isbn = normalizeValidIsbn(item?.isbn);
    const record = isbn ? loteByIsbn.get(isbn) : null;
    if (!record) continue;
    const after = applyBookEnrichment(item);
    const before = withoutLoteFacts(after, record);
    fichas.push({
      id: clean(item.id).toUpperCase(),
      isbn,
      antes: EDITION_FIELDS.filter(field => Boolean(existingFact(before, field))),
      despues: EDITION_FIELDS.filter(field => Boolean(existingFact(after, field))),
      ganados: gainedFields(before, after),
      fuentes: [...new Set((record.provenance || []).map(source => source.provider))],
    });
  }

  const beneficiadas = fichas.filter(f => f.ganados.length > 0);
  const isbnBeneficiados = new Set(beneficiadas.map(f => f.isbn));

  const report = {
    schemaVersion: 1,
    fetchedAt,
    source: CATALOG_URL,
    catalogUpdatedAt: catalog?.updated_at || null,
    lotes: modulePaths,
    registros_de_lote: registrosDeLote,
    universo: {
      fichas_activas_con_stock: activos.length,
      isbn_investigados: investigated,
      isbn_incorporados: loteByIsbn.size,
      isbn_con_ficha_viva: new Set(fichas.map(f => f.isbn)).size,
      isbn_que_benefician_alguna_ficha: isbnBeneficiados.size,
      fichas_beneficiadas: beneficiadas.length,
    },
    conteos: summarizeFichas(fichas),
    tabla_por_campo: buildFieldTable(fichas),
    fichas,
  };

  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, 'enrichment-impact-report.json'), `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== IMPACTO REAL POR FICHA ===');
  console.log(JSON.stringify({ ...report, fichas: undefined }, null, 2));
  console.log('\n=== CAMPO | ANTES | DESPUÉS | +FICHAS ===');
  for (const [field, row] of Object.entries(report.tabla_por_campo)) {
    console.log(`${field.padEnd(18)} | ${String(row.antes).padStart(6)} | ${String(row.despues).padStart(7)} | ${row.mas_fichas >= 0 ? '+' : ''}${row.mas_fichas}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
