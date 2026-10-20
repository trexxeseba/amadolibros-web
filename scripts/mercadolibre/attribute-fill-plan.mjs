#!/usr/bin/env node

// Plan de carga de atributos en MODO REPORTE (paso 2, sin escribir nada).
//
// Cruza las publicaciones activas de libros con los datos verificados por ISBN
// del registro de fichas y propone, por publicación, qué atributo de MLU se
// completaría y con qué valor. No llama a Mercado Libre y no modifica nada: deja
// un CSV "antes / propuesto" para que Seba lo revise antes de cualquier carga.
//
// Reglas:
//  - Sólo se propone un atributo cuando la publicación NO lo tiene (estado 'falta'
//    medido) y el registro trae un valor verificado para ese ISBN.
//  - Nunca se propone nada para publicaciones de Catálogo (catalog_listing) ni
//    fuera de la categoría de libros, vinculadas a User Products o sin evidencia
//    suficiente para descartar esa vinculación (incluido un espejo antiguo).
//  - En modo espejo sólo año e idioma son medibles; editorial y páginas se
//    marcan 'a_confirmar' hasta correr la auditoría cruda (--raw).
//  - El piloto toma las N de mayor prioridad que tengan al menos una propuesta
//    firme (default 20).
//
// Uso:
//   node scripts/mercadolibre/attribute-fill-plan.mjs [--raw items.json] [--catalog ruta] [--pilot 20] [--out dir]

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { listBookEnrichments } from '../../functions/_shared/book-enrichment-registry.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { bulkEntryItem } from '../../worker-sync/meli-bulk.js';
import { auditItem, priorityScore } from './attribute-audit.mjs';

// Atributo de MLU (categoría MLU1196) <- clave de auditoría <- valor verificado.
export const FILL_FIELDS = Object.freeze([
  { key: 'year',      mluId: 'PUBLICATION_YEAR', value: facts => facts.bibliographic?.publication_year },
  { key: 'language',  mluId: 'LANGUAGE',         value: facts => facts.bibliographic?.language },
  { key: 'publisher', mluId: 'BOOK_PUBLISHER',   value: facts => facts.publisher },
  { key: 'pages',     mluId: 'PAGES_NUMBER',     value: facts => (Number(facts.pages) > 0 ? Number(facts.pages) : null) },
  { key: 'edition',   mluId: 'BOOK_EDITION',     value: facts => facts.bibliographic?.edition },
]);

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

export function buildFillPlan({ items, mode = 'mirror', registry, pilot = 20 }) {
  const byIsbn = new Map();
  for (const record of registry) {
    const isbn = normalizeValidIsbn(record.isbn);
    if (isbn) byIsbn.set(isbn, record);
  }
  const rows = [];
  const excluded = { user_product: 0, user_product_unknown: 0 };
  for (const item of items) {
    if (item.category_id !== 'MLU1196' || item.catalog_listing === true) continue;
    if (item.status !== undefined && item.status !== 'active') continue;
    const exclusion = userProductExclusion(item);
    if (exclusion) { excluded[exclusion] += 1; continue; }
    const isbn = normalizeValidIsbn(item.isbn ?? item.attributes?.find(a => ['GTIN', 'ISBN'].includes(String(a.id).toUpperCase()))?.value_name);
    const record = isbn ? byIsbn.get(isbn) : null;
    if (!record) continue;
    const status = auditItem(item, mode);
    const firm = [];
    const toConfirm = [];
    for (const field of FILL_FIELDS) {
      const value = clean(field.value(record.facts || {}));
      if (!value) continue;
      if (status[field.key] === 'falta') firm.push({ mluId: field.mluId, value });
      else if (status[field.key] === 'no_medible') toConfirm.push({ mluId: field.mluId, value });
    }
    if (!firm.length && !toConfirm.length) continue;
    const missing = Object.keys(status).filter(key => status[key] === 'falta');
    rows.push({
      id: item.id, isbn, title: clean(item.title), sold: Number(item.sold_quantity) || 0,
      firm, toConfirm,
      score: priorityScore({ missing, stock: Number(item.available_quantity) || 0, sold: Number(item.sold_quantity) || 0, catalogListing: false }),
    });
  }
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const withFirm = rows.filter(row => row.firm.length);
  return {
    mode,
    excluded,
    candidates: rows.length,
    with_firm_proposal: withFirm.length,
    firm_by_attribute: Object.fromEntries(FILL_FIELDS.map(f => [f.mluId, withFirm.filter(r => r.firm.some(x => x.mluId === f.mluId)).length])),
    pilot: withFirm.slice(0, pilot),
    rows,
  };
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const fmt = list => list.map(x => `${x.mluId}=${x.value}`).join(' | ');

export function renderPlanCsv(rows) {
  const header = ['id', 'isbn', 'titulo', 'vendidos', 'cargaria_firme', 'a_confirmar_con_auditoria_cruda'];
  return [header.join(','), ...rows.map(r => [r.id, r.isbn, r.title, r.sold, fmt(r.firm), fmt(r.toConfirm)].map(csvCell).join(','))].join('\n') + '\n';
}

export function renderPlanMarkdown(plan, generatedAt) {
  const lines = [
    '# Plan de carga de atributos (modo reporte, no escribe nada)',
    '',
    `Generado: ${generatedAt}. Fuente de medición: ${plan.mode === 'raw' ? 'atributos crudos de MLU' : 'espejo del catálogo (editorial y páginas sin medir)'}.`,
    '',
    `- Publicaciones con dato verificado disponible: **${plan.candidates}**`,
    `- Con carga firme (el atributo falta y hay dato verificado): **${plan.with_firm_proposal}**`,
    `- Excluidas por User Product: **${plan.excluded.user_product}**`,
    `- Excluidas por vinculación desconocida: **${plan.excluded.user_product_unknown}** (requieren una auditoría nueva con campos de vinculación).`,
    ...Object.entries(plan.firm_by_attribute).map(([id, n]) => `- ${id}: ${n}`),
    '',
    `## Piloto (${plan.pilot.length})`,
    '',
    '| ID | Título | Se cargaría |',
    '|---|---|---|',
    ...plan.pilot.map(r => `| ${r.id} | ${r.title.replace(/\|/g, '/').slice(0, 60)} | ${fmt(r.firm)} |`),
    '',
    'El listado completo está en `plan-carga.csv`. Revisar antes de cualquier carga real.',
    '',
  ];
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
  const args = { raw: null, catalog: CATALOG_URL, pilot: '20', out: 'reports/mlu-atributos' };
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (!['--raw', '--catalog', '--pilot', '--out'].includes(flag) || !argv[i + 1]) throw new Error(`Argumento no válido: ${flag}`);
    args[flag.slice(2)] = argv[i + 1];
  }
  const pilot = Number(args.pilot);
  if (!Number.isInteger(pilot) || pilot < 1 || pilot > 200) throw new Error('--pilot debe ser un entero entre 1 y 200');
  let items, mode;
  if (args.raw) {
    const data = await readJson(args.raw);
    items = (Array.isArray(data) ? data : data.items || []).map(entry => bulkEntryItem(entry)).filter(Boolean);
    mode = 'raw';
  } else {
    const data = await readJson(args.catalog);
    items = Array.isArray(data) ? data : data.items || [];
    mode = 'mirror';
  }
  const plan = buildFillPlan({ items, mode, registry: listBookEnrichments(), pilot });
  await mkdir(args.out, { recursive: true });
  const generatedAt = new Date().toISOString();
  await writeFile(path.join(args.out, 'plan-carga.md'), renderPlanMarkdown(plan, generatedAt));
  await writeFile(path.join(args.out, 'plan-carga.csv'), renderPlanCsv(plan.rows));
  console.log(`Candidatas ${plan.candidates}; con carga firme ${plan.with_firm_proposal}; piloto ${plan.pilot.length}. Informe en ${args.out}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
