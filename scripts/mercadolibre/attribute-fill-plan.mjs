#!/usr/bin/env node

// Plan de carga de atributos en MODO REPORTE (paso 2, sin escribir nada).
//
// Cruza las publicaciones activas de libros con datos por ISBN y propone, por
// publicación, qué atributo de MLU se completaría y con qué valor. No llama a
// Mercado Libre y no modifica nada: deja un CSV "antes / propuesto" para que
// Seba lo revise antes de cualquier carga.
//
// Fuentes por ISBN:
//  - el registro verificado de fichas (siempre);
//  - Open Library y Google Books (sólo con --isbn-sources N, que consulta como
//    máximo N ISBN; ver isbn-public-sources.mjs). Sólo viaja el ISBN.
//
// Reglas:
//  - Sólo se propone un atributo cuando la publicación NO lo tiene (estado 'falta'
//    medido) y alguna fuente trae el dato de forma explícita.
//  - Si dos fuentes discrepan en un campo, ese campo queda sin propuesta y la
//    discrepancia se anota (discrepancias.csv).
//  - Nunca se propone nada para publicaciones de Catálogo (catalog_listing) ni
//    fuera de la categoría de libros.
//  - Las vinculadas a User Products NO se descartan: van a un grupo aparte
//    ("requieren carga por user product") con su propuesta, y este plan no
//    intenta cargarlas. Las que no traen evidencia de vinculación (espejo
//    antiguo) siguen excluidas.
//  - En modo espejo sólo año, idioma y género son medibles; el resto se marca
//    'a_confirmar' hasta correr la auditoría cruda (--raw).
//  - El piloto toma las N de mayor prioridad de carga directa que tengan al
//    menos una propuesta firme (default 20).
//
// Uso:
//   node scripts/mercadolibre/attribute-fill-plan.mjs [--raw items.json] [--catalog ruta] [--pilot 20] [--out dir]
//                                                     [--isbn-sources 300] [--cache dir-fuera-del-repo]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import { bulkEntryItem } from '../../worker-sync/meli-bulk.js';
import { auditItem, priorityScore } from './attribute-audit.mjs';
import { coverFromFormat, defaultCacheDir, itemIsbn, lookupIsbns, normalizeGtinIsbn, resolveField } from './isbn-public-sources.mjs';

// Atributo de MLU (categoría MLU1196) <- clave de auditoría <- valor del registro verificado.
export const FILL_FIELDS = Object.freeze([
  { key: 'year',      mluId: 'PUBLICATION_YEAR', value: facts => facts.bibliographic?.publication_year },
  { key: 'language',  mluId: 'LANGUAGE',         value: facts => facts.bibliographic?.language },
  { key: 'publisher', mluId: 'BOOK_PUBLISHER',   value: facts => facts.publisher },
  { key: 'pages',     mluId: 'PAGES_NUMBER',     value: facts => (Number(facts.pages) > 0 ? Number(facts.pages) : null) },
  { key: 'edition',   mluId: 'BOOK_EDITION',     value: facts => facts.bibliographic?.edition },
  { key: 'cover',     mluId: 'BOOK_COVER',       value: facts => coverFromFormat(facts.bibliographic?.format) },
  { key: 'genre',     mluId: 'BOOK_GENRE',       value: facts => facts.bibliographic?.genre },
]);

const BOOKS_CATEGORY = 'MLU1196';
const EXTERNAL_SOURCES = ['openlibrary', 'googlebooks'];

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function userProductExclusion(item) {
  const linked = value => value !== undefined && value !== null;
  const variations = Array.isArray(item.variations) ? item.variations : [];
  if (linked(item.user_product_id) || variations.some(v => linked(v?.user_product_id))) return 'user_product';
  if (item.user_product_id !== null || !Array.isArray(item.variations) ||
      variations.some(v => v?.user_product_id !== null)) return 'user_product_unknown';
  return null;
}

function planEligible(item) {
  return item.category_id === BOOKS_CATEGORY && item.catalog_listing !== true &&
    (item.status === undefined || item.status === 'active');
}

function itemScore(item, status) {
  const missing = Object.keys(status).filter(key => status[key] === 'falta');
  return priorityScore({ missing, stock: Number(item.available_quantity) || 0, sold: Number(item.sold_quantity) || 0, catalogListing: false });
}

/**
 * ISBN a consultar en las fuentes públicas: los de publicaciones del plan a las
 * que les falta algún atributo completable, de mayor a menor prioridad, sin
 * repetir y con tope.
 */
export function isbnsToLookup({ items, mode = 'mirror', limit = 300 }) {
  const wanted = [];
  for (const item of items) {
    if (!planEligible(item) || userProductExclusion(item) === 'user_product_unknown') continue;
    const status = auditItem(item, mode);
    if (!FILL_FIELDS.some(field => status[field.key] === 'falta')) continue;
    const isbn = itemIsbn(item);
    if (isbn) wanted.push({ isbn, score: itemScore(item, status), id: String(item.id) });
  }
  wanted.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return [...new Set(wanted.map(entry => entry.isbn))].slice(0, limit);
}

function summarize(rows) {
  const withFirm = rows.filter(row => row.firm.length);
  return {
    candidates: rows.length,
    with_firm_proposal: withFirm.length,
    firm_by_attribute: Object.fromEntries(FILL_FIELDS.map(f => [f.mluId, withFirm.filter(r => r.firm.some(x => x.mluId === f.mluId)).length])),
  };
}

/** external: Map(isbn -> { openlibrary: facts|null, googlebooks: facts|null }). */
export function buildFillPlan({ items, mode = 'mirror', registry, pilot = 20, external = new Map() }) {
  const byIsbn = new Map();
  for (const record of registry) {
    const isbn = normalizeGtinIsbn(record.isbn);
    if (isbn) byIsbn.set(isbn, record);
  }
  // Cuántos avisos activos del archivo comparten cada User Product (incluye Catálogo).
  const sharing = new Map();
  for (const item of items) {
    if (item.user_product_id === undefined || item.user_product_id === null) continue;
    if (item.status !== undefined && item.status !== 'active') continue;
    sharing.set(item.user_product_id, (sharing.get(item.user_product_id) || 0) + 1);
  }
  const rows = [];
  const userProductRows = [];
  const excluded = { user_product: 0, user_product_unknown: 0 };
  for (const item of items) {
    if (!planEligible(item)) continue;
    const exclusion = userProductExclusion(item);
    if (exclusion) excluded[exclusion] += 1;
    if (exclusion === 'user_product_unknown') continue;
    const isbn = itemIsbn(item);
    const record = isbn ? byIsbn.get(isbn) : null;
    const publicFacts = isbn ? external.get(isbn) : null;
    if (!record && !publicFacts) continue;
    const status = auditItem(item, mode);
    const firm = [];
    const toConfirm = [];
    const discrepancies = [];
    for (const field of FILL_FIELDS) {
      if (!['falta', 'no_medible'].includes(status[field.key])) continue;
      const resolved = resolveField(field.key, [
        { source: 'registro', value: record ? field.value(record.facts || {}) : null },
        ...EXTERNAL_SOURCES.map(source => ({ source, value: publicFacts?.[source]?.[field.key] })),
      ]);
      if (!resolved) continue;
      if (resolved.discrepancy) {
        if (status[field.key] === 'falta') discrepancies.push({ mluId: field.mluId, values: resolved.discrepancy });
        continue;
      }
      const proposal = { mluId: field.mluId, value: resolved.value, sources: resolved.sources };
      (status[field.key] === 'falta' ? firm : toConfirm).push(proposal);
    }
    if (!firm.length && !toConfirm.length && !discrepancies.length) continue;
    const linked = exclusion === 'user_product';
    (linked ? userProductRows : rows).push({
      id: item.id, isbn, title: clean(item.title), sold: Number(item.sold_quantity) || 0,
      group: linked ? 'requiere_carga_por_user_product' : 'carga_directa',
      user_product_id: linked ? (item.user_product_id ?? null) : null,
      user_product_listings: linked && item.user_product_id != null ? sharing.get(item.user_product_id) || 1 : null,
      firm, toConfirm, discrepancies,
      score: itemScore(item, status),
    });
  }
  const order = (a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id));
  rows.sort(order);
  userProductRows.sort(order);
  return {
    mode,
    excluded,
    ...summarize(rows),
    pilot: rows.filter(row => row.firm.length).slice(0, pilot),
    rows,
    user_product: {
      ...summarize(userProductRows),
      alone_in_user_product: userProductRows.filter(row => row.firm.length && row.user_product_listings === 1).length,
      rows: userProductRows,
    },
    discrepancies: [...rows, ...userProductRows].reduce((sum, row) => sum + row.discrepancies.length, 0),
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const fmt = list => list.map(x => `${x.mluId}=${x.value}`).join(' | ');
const fmtSources = list => list.map(x => `${x.mluId}:${(x.sources || []).join('+')}`).join(' | ');
const fmtValues = values => values.map(v => `${v.source}=${v.value}`).join(' / ');

export function renderPlanCsv(rows) {
  const header = ['grupo', 'id', 'isbn', 'titulo', 'vendidos', 'user_product_id', 'avisos_activos_en_el_user_product', 'cargaria_firme', 'fuentes', 'a_confirmar_con_auditoria_cruda', 'sin_propuesta_por_discrepancia'];
  return [header.join(','), ...rows.map(r => [
    r.group, r.id, r.isbn, r.title, r.sold, r.user_product_id, r.user_product_listings, fmt(r.firm), fmtSources(r.firm), fmt(r.toConfirm),
    (r.discrepancies || []).map(d => `${d.mluId}: ${fmtValues(d.values)}`).join(' | '),
  ].map(csvCell).join(','))].join('\n') + '\n';
}

export function renderDiscrepanciesCsv(rows) {
  const lines = rows.flatMap(r => (r.discrepancies || []).map(d =>
    [r.group, r.id, r.isbn, r.title, d.mluId, fmtValues(d.values)].map(csvCell).join(',')));
  return ['grupo,id,isbn,titulo,atributo,valores_por_fuente', ...lines].join('\n') + '\n';
}

const SOURCE_LABELS = { openlibrary: 'Open Library', googlebooks: 'Google Books' };

export function renderPlanMarkdown(plan, generatedAt, lookup = null) {
  const table = rows => [
    '| ID | Título | Se cargaría | Fuentes |',
    '|---|---|---|---|',
    ...rows.map(r => `| ${r.id} | ${r.title.replace(/\|/g, '/').slice(0, 60)} | ${fmt(r.firm)} | ${fmtSources(r.firm)} |`),
  ];
  const lines = [
    '# Plan de carga de atributos (modo reporte, no escribe nada)',
    '',
    `Generado: ${generatedAt}. Fuente de medición: ${plan.mode === 'raw' ? 'atributos crudos de MLU' : 'espejo del catálogo (editorial y páginas sin medir)'}.`,
    '',
    '## Carga directa (sin User Product)',
    '',
    `- Publicaciones con dato disponible: **${plan.candidates}**`,
    `- Con carga firme (el atributo falta y hay dato): **${plan.with_firm_proposal}**`,
    ...Object.entries(plan.firm_by_attribute).map(([id, n]) => `- ${id}: ${n}`),
    '',
    '## Requieren carga por User Product (este plan no las carga)',
    '',
    `- Vinculadas a User Products dentro del plan: **${plan.excluded.user_product}**`,
    `- Con dato disponible: **${plan.user_product.candidates}**`,
    `- Con propuesta firme: **${plan.user_product.with_firm_proposal}**`,
    `- De esas, únicas activas en su User Product: **${plan.user_product.alone_in_user_product}**`,
    ...Object.entries(plan.user_product.firm_by_attribute).map(([id, n]) => `- ${id}: ${n}`),
    '',
    '## Sin propuesta',
    '',
    `- Campos sin propuesta porque dos fuentes discrepan: **${plan.discrepancies}** (detalle en \`discrepancias.csv\`).`,
    `- Excluidas por vinculación desconocida: **${plan.excluded.user_product_unknown}** (requieren una auditoría nueva con campos de vinculación).`,
    '',
  ];
  if (lookup) {
    lines.push('## Fuentes públicas consultadas', '', `ISBN consultados: **${lookup.requested}** (sólo viaja el ISBN).`, '',
      '| Fuente | Con dato | No encontrado | Sin dato útil | Errores | No consultados por bloqueo de cuota | Desde caché |',
      '|---|---:|---:|---:|---:|---:|---:|');
    for (const [name, s] of Object.entries(lookup.sources)) {
      lines.push(`| ${SOURCE_LABELS[name] || name} | ${s.with_data} | ${s.not_found} | ${s.without_usable_data} | ${s.errors} | ${s.skipped_blocked} | ${s.from_cache} |`);
    }
    lines.push('');
  }
  lines.push(`## Piloto de carga directa (${plan.pilot.length})`, '', ...table(plan.pilot), '',
    '## Primeras 20 que requieren carga por User Product', '',
    ...table(plan.user_product.rows.filter(r => r.firm.length).slice(0, 20)), '',
    'El listado completo está en `plan-carga.csv`. Revisar antes de cualquier carga real.', '');
  return lines.join('\n');
}

async function readJson(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondió HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

export async function main(argv = process.argv.slice(2)) {
  const args = { raw: null, catalog: CATALOG_URL, pilot: '20', out: 'reports/mlu-atributos', 'isbn-sources': '0', cache: defaultCacheDir() };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--raw', '--catalog', '--pilot', '--out', '--isbn-sources', '--cache'].includes(flag) || !argv[i + 1]) throw new Error(`Argumento no válido: ${flag}`);
    args[flag.slice(2)] = argv[i + 1];
  }
  const pilot = Number(args.pilot);
  if (!Number.isInteger(pilot) || pilot < 1 || pilot > 200) throw new Error('--pilot debe ser un entero entre 1 y 200');
  const lookupLimit = Number(args['isbn-sources']);
  if (!Number.isInteger(lookupLimit) || lookupLimit < 0 || lookupLimit > 1000) throw new Error('--isbn-sources debe ser un entero entre 0 y 1000');
  let items, mode;
  if (args.raw) {
    const data = await readJson(args.raw);
    if (data?.complete === false) throw new Error('Auditoría incompleta: el archivo es evidencia de diagnóstico, no una base válida para propuestas.');
    items = (Array.isArray(data) ? data : data.items || []).map(entry => bulkEntryItem(entry)).filter(Boolean);
    mode = 'raw';
  } else {
    const data = await readJson(args.catalog);
    items = Array.isArray(data) ? data : data.items || [];
    mode = 'mirror';
  }
  let lookup = null;
  if (lookupLimit > 0) {
    const cacheDir = path.resolve(args.cache);
    const inside = path.relative(process.cwd(), cacheDir);
    if (!inside.startsWith('..') && !path.isAbsolute(inside)) throw new Error('--cache tiene que apuntar fuera del repo');
    lookup = await lookupIsbns(isbnsToLookup({ items, mode, limit: lookupLimit }), { limit: lookupLimit, cacheDir });
  }
  const plan = buildFillPlan({ items, mode, registry: listBookEnrichments(), pilot, external: lookup?.byIsbn });
  await mkdir(args.out, { recursive: true });
  const generatedAt = new Date().toISOString();
  const allRows = [...plan.rows, ...plan.user_product.rows];
  const summary = { generated_at: generatedAt, ...plan, pilot: undefined, rows: undefined, user_product: { ...plan.user_product, rows: undefined }, lookup: lookup?.stats ?? null };
  await writeFile(path.join(args.out, 'plan-carga.md'), renderPlanMarkdown(plan, generatedAt, lookup?.stats));
  await writeFile(path.join(args.out, 'plan-carga.csv'), renderPlanCsv(allRows));
  await writeFile(path.join(args.out, 'discrepancias.csv'), renderDiscrepanciesCsv(allRows));
  await writeFile(path.join(args.out, 'plan-resumen.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(`Carga directa: ${plan.candidates} candidatas, ${plan.with_firm_proposal} con carga firme. Por User Product: ${plan.user_product.candidates} candidatas, ${plan.user_product.with_firm_proposal} con propuesta firme. Discrepancias: ${plan.discrepancies}. Informe en ${args.out}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
