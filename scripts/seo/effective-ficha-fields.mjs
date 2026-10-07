import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Emite, para cada publicación activa del snapshot, qué campos tiene su ficha
// EFECTIVA con el registro de ESTA copia del repo.
//
// Corriéndolo dos veces —una en un worktree de `main` y otra en el PR— sobre
// el MISMO snapshot, la diferencia entre ambas salidas es el impacto real del
// PR, sin reconstrucciones ni supuestos.

const EDITION_FIELDS = Object.freeze([
  'author', 'publisher', 'pages', 'language', 'format', 'edition', 'publication_year', 'topics',
]);

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function fieldsPresent(item, isGenericAuthor) {
  const bib = item?.bibliographic && typeof item.bibliographic === 'object' ? item.bibliographic : {};
  const present = [];
  if (!isGenericAuthor(item?.author) && clean(item?.author)) present.push('author');
  if (clean(item?.publisher)) present.push('publisher');
  if (Number(item?.pages) > 0) present.push('pages');
  for (const field of ['language', 'format', 'edition', 'publication_year']) {
    if (clean(bib[field])) present.push(field);
  }
  if (Array.isArray(bib.subjects) && bib.subjects.some(clean)) present.push('topics');
  return present.sort((a, b) => EDITION_FIELDS.indexOf(a) - EDITION_FIELDS.indexOf(b));
}

export async function main() {
  const snapshotPath = process.env.CATALOG_SNAPSHOT;
  const outputPath = process.env.FIELDS_OUTPUT;
  const label = process.env.FIELDS_LABEL || 'sin-etiqueta';
  if (!snapshotPath || !outputPath) throw new Error('Faltan CATALOG_SNAPSHOT y FIELDS_OUTPUT.');

  // Se importan desde ESTA copia del repo a propósito: en el worktree de main
  // resuelven al registro de main.
  const { applyBookEnrichment, listBookEnrichments } = await import('../../functions/_shared/book-enrichment-registry.js');
  const { isGenericAuthor, normalizeValidIsbn } = await import('../../functions/_shared/showcase-ranking.js');

  const catalog = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const activos = (Array.isArray(catalog?.items) ? catalog.items : [])
    .filter(item => item?.status === 'active' && Number(item.available_quantity) > 0);

  const fichas = {};
  for (const item of activos) {
    const id = clean(item.id).toUpperCase();
    if (!id) continue;
    fichas[id] = {
      isbn: normalizeValidIsbn(item?.isbn) || null,
      campos: fieldsPresent(applyBookEnrichment(item), isGenericAuthor),
    };
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    label,
    catalogUpdatedAt: catalog?.updated_at || null,
    registryIsbns: listBookEnrichments().length,
    fichasActivas: activos.length,
    fichas,
  }, null, 2)}\n`);

  console.log(JSON.stringify({
    label,
    registryIsbns: listBookEnrichments().length,
    fichasActivas: activos.length,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
