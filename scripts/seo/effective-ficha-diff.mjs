import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Reconcilia el impacto del PR: diferencia exacta entre la ficha efectiva de
// `main` y la del PR sobre el MISMO snapshot de catálogo.

const EDITION_FIELDS = Object.freeze([
  'author', 'publisher', 'pages', 'language', 'format', 'edition', 'publication_year', 'topics',
]);

export function diffFichas(antes, despues) {
  const filas = [];
  for (const [id, after] of Object.entries(despues.fichas || {})) {
    const before = (antes.fichas || {})[id];
    // Una ficha que no existía en el snapshot de `main` no es una mejora del
    // PR: es una diferencia de catálogo y se informa aparte.
    if (!before) { filas.push({ id, isbn: after.isbn, soloEnDespues: true, ganados: [] }); continue; }
    const previos = new Set(before.campos);
    const ganados = after.campos.filter(field => !previos.has(field));
    const perdidos = before.campos.filter(field => !after.campos.includes(field));
    filas.push({ id, isbn: after.isbn, ganados, perdidos });
  }
  return filas;
}

export function resumen(filas) {
  const beneficiadas = filas.filter(f => f.ganados.length > 0);
  const conPerdida = filas.filter(f => (f.perdidos || []).length > 0);
  const porCampo = {};
  for (const fila of beneficiadas) {
    for (const field of fila.ganados) porCampo[field] = (porCampo[field] || 0) + 1;
  }
  return {
    fichas_comparables: filas.filter(f => !f.soloEnDespues).length,
    fichas_solo_en_despues: filas.filter(f => f.soloEnDespues).length,
    fichas_beneficiadas: beneficiadas.length,
    fichas_con_1_o_mas: beneficiadas.length,
    fichas_con_3_o_mas: beneficiadas.filter(f => f.ganados.length >= 3).length,
    fichas_que_pierden_algun_campo: conPerdida.length,
    isbn_unicos_con_mejora: new Set(beneficiadas.map(f => f.isbn).filter(Boolean)).size,
    mejoras_por_campo: Object.fromEntries(
      EDITION_FIELDS.filter(field => porCampo[field]).map(field => [field, porCampo[field]]),
    ),
  };
}

export async function main() {
  const antesPath = process.env.FIELDS_ANTES;
  const despuesPath = process.env.FIELDS_DESPUES;
  const outputPath = process.env.DIFF_OUTPUT || 'artifacts/reconciliacion/effective-ficha-diff.json';
  if (!antesPath || !despuesPath) throw new Error('Faltan FIELDS_ANTES y FIELDS_DESPUES.');

  const antes = JSON.parse(await readFile(antesPath, 'utf8'));
  const despues = JSON.parse(await readFile(despuesPath, 'utf8'));
  if (antes.catalogUpdatedAt !== despues.catalogUpdatedAt) {
    throw new Error('Los dos lados no comparten snapshot; la comparación no sería válida.');
  }

  // Los valores esperados salen del registro de ESTA copia (el PR): son los
  // que el Preview tiene que mostrar en cada ficha beneficiada.
  const { getBookEnrichmentByIsbn } = await import('../../functions/_shared/book-enrichment-registry.js');
  const valoresEsperados = isbn => {
    const facts = getBookEnrichmentByIsbn(isbn)?.facts || {};
    const bib = facts.bibliographic || {};
    return {
      publisher: facts.publisher || null,
      pages: facts.pages || null,
      author: facts.author || null,
      language: bib.language || null,
      publication_year: bib.publication_year || null,
    };
  };

  const filas = diffFichas(antes, despues);
  const totales = resumen(filas);
  const beneficiadas = filas.filter(f => f.ganados.length > 0);

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshot: { catalogUpdatedAt: despues.catalogUpdatedAt, fichasActivas: despues.fichasActivas },
    antes: { label: antes.label, registryIsbns: antes.registryIsbns },
    despues: { label: despues.label, registryIsbns: despues.registryIsbns },
    crecimiento_del_registro: despues.registryIsbns - antes.registryIsbns,
    totales,
    // Plan para la validación del Preview: qué ficha y qué debe mostrar.
    fichas: beneficiadas.map(fila => ({
      id: fila.id,
      isbn: fila.isbn,
      ganados: fila.ganados,
      esperado: Object.fromEntries(
        Object.entries(valoresEsperados(fila.isbn))
          .filter(([campo, valor]) => valor && fila.ganados.includes(campo === 'publication_year' ? 'publication_year' : campo)),
      ),
    })),
    fichas_beneficiadas: beneficiadas,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log('=== RECONCILIACIÓN: FICHA EFECTIVA main vs PR ===');
  console.log(JSON.stringify({ ...report, fichas_beneficiadas: undefined }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
}
