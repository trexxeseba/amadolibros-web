#!/usr/bin/env node

// Auditoría de SOLO LECTURA de los atributos de las publicaciones de Amado
// Libros en Mercado Libre Uruguay (categoría de libros MLU1196).
//
// No escribe en Mercado Libre: no hace PUT, POST ni DELETE, no toca títulos,
// precios, descripciones ni Catálogo. Sólo lee y deja un informe en
// reports/mlu-atributos/.
//
// Dos modos de entrada:
//
//   --raw ARCHIVO   Atributos CRUDOS de MLU: un JSON con items completos
//                   (con `attributes`) o con entradas de /items/bulk
//                   ({status_code, body}). Es la medición confiable.
//
//   (por defecto)   El espejo publicado del catálogo (catalog.json). El espejo
//                   lee los atributos con ids que NO coinciden con los de la
//                   categoría de libros (p. ej. páginas es PAGES_NUMBER y el
//                   espejo busca NUMBER_OF_PAGES), así que sólo se miden los
//                   campos que sí lee bien; el resto queda "no medible" y no
//                   se cuenta como faltante.
//
// Prioridad opcional:  --priority ARCHIVO  con { "MLU123": {"visits": 10, "sold": 2} }
//
// Uso:
//   node scripts/mercadolibre/attribute-audit.mjs
//   node scripts/mercadolibre/attribute-audit.mjs --raw items.json --priority visitas.json
//   node scripts/mercadolibre/attribute-audit.mjs --catalog ruta/catalog.json --out reports/mlu-atributos

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CATALOG_URL } from '../../functions/_shared/catalog.js';
import { normalizeValidIsbn } from '../../functions/_shared/showcase-ranking.js';
import { bulkEntryItem } from '../../worker-sync/meli-bulk.js';

const DEFAULT_OUTPUT_DIR = 'reports/mlu-atributos';
const BOOKS_CATEGORY = 'MLU1196';

// Ids reales de la categoría MLU1196 (GET /categories/MLU1196/attributes).
// `weight` pesa el faltante en la prioridad: los obligatorios de Catálogo
// (catalog_required) pesan más porque habilitan la ficha estructurada.
export const BOOK_ATTRIBUTES = Object.freeze([
  { key: 'author',    label: 'Autor',            ids: ['AUTHOR'],                               weight: 30, mirror: item => item.author },
  { key: 'isbn',      label: 'ISBN',             ids: ['GTIN', 'ISBN'],                         weight: 30, mirror: item => normalizeValidIsbn(item.isbn) },
  { key: 'publisher', label: 'Editorial',        ids: ['BOOK_PUBLISHER', 'PUBLISHER'],          weight: 30, mirror: null },
  { key: 'language',  label: 'Idioma',           ids: ['LANGUAGE'],                             weight: 15, mirror: item => item.bibliographic?.language },
  { key: 'year',      label: 'Año de publicación', ids: ['PUBLICATION_YEAR'],                   weight: 15, mirror: item => item.bibliographic?.publication_year },
  { key: 'pages',     label: 'Cantidad de páginas', ids: ['PAGES_NUMBER'],                      weight: 15, mirror: null },
  { key: 'cover',     label: 'Tapa',             ids: ['BOOK_COVER'],                           weight: 10, mirror: null },
  { key: 'edition',   label: 'Edición',          ids: ['BOOK_EDITION'],                         weight: 5,  mirror: null },
  { key: 'genre',     label: 'Género',           ids: ['BOOK_GENRE'],                           weight: 5,  mirror: item => item.bibliographic?.genre },
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// N/A (-1) es una decisión explícita, no un dato pendiente de completar.
function attributeIsNotApplicable(attribute) {
  return clean(attribute?.value_id ?? attribute?.id) === '-1';
}

export function attributeHasValue(attribute) {
  if (!attribute || typeof attribute !== 'object') return false;
  if (attributeIsNotApplicable(attribute)) return false;
  if (Array.isArray(attribute.values) && attribute.values.some(value =>
    attributeHasValue({ value_id: value.id, value_name: value.name, value_struct: value.struct }))) return true;
  const name = clean(attribute.value_name);
  if (name && !/^(null|undefined|n\/a|-)$/i.test(name)) return true;
  const struct = attribute.value_struct;
  if (struct && Number(struct.number) > 0) return true;
  const valueId = clean(attribute.value_id);
  return Boolean(valueId) && valueId !== '-1';
}

export function rawAttributeStatus(attributes, spec) {
  if (!Array.isArray(attributes)) return 'no_medible';
  const wanted = new Set(spec.ids);
  const found = attributes.filter(a => wanted.has(String(a?.id ?? '').toUpperCase()));
  // Ante aliases contradictorios, conservar N/A y no proponer un reemplazo.
  if (found.some(a => attributeIsNotApplicable(a) || (Array.isArray(a.values) && a.values.some(attributeIsNotApplicable)))) return 'no_aplica';
  return found.some(attributeHasValue) ? 'ok' : 'falta';
}

function mirrorAttributeStatus(item, spec) {
  if (!spec.mirror) return 'no_medible';
  const value = spec.mirror(item);
  if (Array.isArray(value)) return value.some(v => clean(v)) ? 'ok' : 'falta';
  return clean(value) ? 'ok' : 'falta';
}

/** Estado: 'ok' | 'falta' | 'no_aplica' | 'no_medible'. */
export function auditItem(item, mode) {
  const status = {};
  // Fuera de la categoría de libros (cartas, antigüedades, etc.) estos atributos no aplican.
  if (item.category_id && item.category_id !== BOOKS_CATEGORY) {
    for (const spec of BOOK_ATTRIBUTES) status[spec.key] = 'no_medible';
    return status;
  }
  for (const spec of BOOK_ATTRIBUTES) {
    status[spec.key] = mode === 'raw'
      ? rawAttributeStatus(item.attributes, spec)
      : mirrorAttributeStatus(item, spec);
  }
  return status;
}

export function priorityScore({ missing, stock, visits = 0, sold = 0, catalogListing = false }) {
  const weight = missing.reduce((sum, key) => sum + (BOOK_ATTRIBUTES.find(spec => spec.key === key)?.weight || 0), 0);
  return weight + Math.min(visits, 500) * 0.5 + Math.min(sold, 50) * 10 + Math.min(stock, 20) + (catalogListing ? 0 : 10);
}

export function buildAudit({ items, mode = 'mirror', priority = {} }) {
  const active = (Array.isArray(items) ? items : []).filter(item =>
    /^MLU\d+$/.test(clean(item?.id).toUpperCase()) && (item.status === undefined || item.status === 'active'));
  const rows = active.map(item => {
    const status = auditItem(item, mode);
    const missing = BOOK_ATTRIBUTES.filter(spec => status[spec.key] === 'falta').map(spec => spec.key);
    const extra = priority[item.id] || {};
    const sold = Number(extra.sold ?? item.sold_quantity) || 0;
    const stock = Number(item.available_quantity) || 0;
    return {
      id: item.id,
      title: clean(item.title),
      category_id: item.category_id || '',
      catalog_listing: item.catalog_listing === true,
      stock,
      visits: Number(extra.visits) || 0,
      sold,
      status,
      missing,
      score: priorityScore({ missing, stock, visits: Number(extra.visits) || 0, sold, catalogListing: item.catalog_listing === true }),
    };
  });
  rows.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const coverage = BOOK_ATTRIBUTES.map(spec => {
    const counts = { ok: 0, falta: 0, no_aplica: 0, no_medible: 0 };
    for (const row of rows) counts[row.status[spec.key]] += 1;
    const measured = counts.ok + counts.falta;
    return { key: spec.key, label: spec.label, ...counts, pct_ok: measured ? Math.round((counts.ok / measured) * 1000) / 10 : null };
  });
  const withMissing = rows.filter(row => row.missing.length);
  return {
    mode,
    total: rows.length,
    with_missing: withMissing.length,
    complete: rows.length - withMissing.length,
    outside_books_category: rows.filter(row => row.category_id && row.category_id !== BOOKS_CATEGORY).length,
    has_priority_data: Object.keys(priority).length > 0,
    coverage,
    rows,
  };
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' · ') : String(value ?? '');
  return /[",\n;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function renderCsv(audit) {
  const header = ['id', 'titulo', 'categoria', 'stock', 'visitas', 'vendidos', 'faltan', 'prioridad'];
  const lines = audit.rows.filter(row => row.missing.length).map(row =>
    [row.id, row.title, row.category_id, row.stock, row.visits, row.sold, row.missing, Math.round(row.score)].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}

export function renderMarkdown(audit, generatedAt) {
  const raw = audit.mode === 'raw';
  const lines = [
    '# Auditoría de atributos en Mercado Libre (solo lectura)',
    '',
    `Generado: ${generatedAt}`,
    `Fuente: ${raw ? 'atributos crudos de MLU' : 'espejo publicado del catálogo (no crudo)'}`,
    '',
    `- Publicaciones activas auditadas: **${audit.total}**`,
    `- Con al menos un atributo medible faltante: **${audit.with_missing}**`,
    `- Sin faltantes medibles: **${audit.complete}**`,
    `- Fuera de la categoría de libros (${BOOKS_CATEGORY}): **${audit.outside_books_category}**`,
    `- Datos de visitas/ventas para priorizar: ${audit.has_priority_data ? 'sí' : 'no (la prioridad usa faltantes, stock y si es de Catálogo)'}`,
    '',
  ];
  if (!raw) {
    lines.push(
      '> **Aviso.** El espejo lee algunos atributos con ids distintos a los de la categoría de libros,',
      '> así que editorial, páginas, tapa y edición figuran como "no medible" y NO se cuentan como',
      '> faltantes. Para medirlos hay que correr la auditoría con `--raw` sobre atributos crudos de MLU.',
      '',
    );
  }
  lines.push('N/A se informa por separado y no genera propuestas de carga.', '');
  lines.push('## Cobertura por atributo', '', '| Atributo | Con dato | Falta | No aplica | No medible | % con dato (aplicables medidos) |', '|---|---:|---:|---:|---:|---:|');
  for (const c of audit.coverage) {
    lines.push(`| ${c.label} | ${c.ok} | ${c.falta} | ${c.no_aplica} | ${c.no_medible} | ${c.pct_ok === null ? '-' : c.pct_ok + '%'} |`);
  }
  lines.push('', '## Primeras 25 por prioridad', '', '| ID | Título | Faltan | Stock |', '|---|---|---|---:|');
  for (const row of audit.rows.filter(r => r.missing.length).slice(0, 25)) {
    lines.push(`| ${row.id} | ${row.title.replace(/\|/g, '/').slice(0, 70)} | ${row.missing.join(', ')} | ${row.stock} |`);
  }
  lines.push('', 'El listado completo está en `faltantes.csv`.', '');
  return lines.join('\n');
}

async function readJsonSource(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${source} respondió HTTP ${response.status}`);
    return response.json();
  }
  return JSON.parse(await readFile(source, 'utf8'));
}

export function parseArgs(argv) {
  const args = { raw: null, catalog: CATALOG_URL, priority: null, out: DEFAULT_OUTPUT_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (['--raw', '--catalog', '--priority', '--out'].includes(flag)) {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${flag} necesita un valor`);
      args[flag.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Argumento desconocido: ${flag}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  let items;
  let mode;
  if (args.raw) {
    const data = await readJsonSource(args.raw);
    items = (Array.isArray(data) ? data : data.items || []).map(entry => bulkEntryItem(entry)).filter(Boolean);
    mode = 'raw';
  } else {
    const data = await readJsonSource(args.catalog);
    items = Array.isArray(data) ? data : data.items || [];
    mode = 'mirror';
  }
  const priority = args.priority ? await readJsonSource(args.priority) : {};
  const audit = buildAudit({ items, mode, priority });
  await mkdir(args.out, { recursive: true });
  const generatedAt = new Date().toISOString();
  await writeFile(path.join(args.out, 'README.md'), renderMarkdown(audit, generatedAt));
  await writeFile(path.join(args.out, 'faltantes.csv'), renderCsv(audit));
  await writeFile(path.join(args.out, 'resumen.json'), JSON.stringify({ generated_at: generatedAt, ...audit, rows: undefined }, null, 2) + '\n');
  console.log(`Auditadas ${audit.total} publicaciones (${mode}); ${audit.with_missing} con faltantes. Informe en ${args.out}/`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
