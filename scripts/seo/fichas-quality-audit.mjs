#!/usr/bin/env node
// FICHAS-QUALITY-GUARD-1 — audita la cohorte real de fichas enriquecidas y
// mide, ficha por ficha, cuánto contenido débil elimina esta corrección.
//
// Por qué existe: la cohorte vive en R2 y no siempre es alcanzable desde el
// entorno donde se desarrolla. Este script permite ejecutar la medición desde
// cualquier lugar que sí tenga red (CI, la máquina de Seba) y obtener números
// reales en vez de estimaciones.
//
// Uso:
//   node scripts/seo/fichas-quality-audit.mjs
//   FICHAS_AUDIT_SAMPLE=30 node scripts/seo/fichas-quality-audit.mjs
//
// No modifica nada. Sólo lee la cohorte y el catálogo, y escribe un informe.

import { writeFileSync, mkdirSync } from 'node:fs';
import { isGenericAuthor } from '../../functions/_shared/showcase-ranking.js';
import { buildAutomaticProductShowcase } from '../../functions/_shared/automatic-product-showcase.js';
import { SHOWCASE_COHORT_V2_URL, normalizeShowcaseCohort } from '../../functions/_shared/showcase-cohort.js';
import { CATALOG_URL } from '../../functions/_shared/catalog.js';

const OUTPUT_DIR = process.env.FICHAS_AUDIT_OUTPUT_DIR || 'artifacts/fichas-quality';
const SAMPLE_SIZE = Math.max(1, Number(process.env.FICHAS_AUDIT_SAMPLE) || 30);

const MIN_USEFUL_DESCRIPTION = 80;

const FRASES_DE_RELLENO = [
  'Disponible para compra inmediata en Amado Libros',
  'La ficha reúne los datos aportados por la publicación',
  'Información comercial verificada al momento de la consulta',
  'Puede interesar a lectores de',
  'Puede interesar a quienes buscan lecturas de',
  'Pensado para lectores de',
  'Para quienes buscan esta obra y necesitan comprobar',
  'La publicación no aporta una autoría suficientemente clara',
];

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`${url} respondió HTTP ${response.status}`);
  return response.json();
}

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

// Reproduce el generador ANTERIOR a esta corrección, para poder contrastar
// antes/después sobre exactamente los mismos datos.
function copyDebilAntes(item) {
  const autor = clean(item.author);
  const esGenericoAhora = isGenericAuthor(autor);
  // Antes sólo se consideraban genéricos los de la lista vieja; 'Desconocido'
  // y 'Unknown' pasaban como autoría real.
  const eraGenericoAntes = !autor || /^(anónimo|anonimo|autor|autores|autor no especificado|no aplica|n\/a|s\/a|sin autor|varios|varios autores|vv aa|vv\. aa\.)$/i
    .test(autor.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  return {
    autor,
    // Fichas que ANTES mostraban "Más sobre <genérico>" y ahora no.
    mostrabaAutorFalso: esGenericoAhora && !eraGenericoAntes,
    esGenericoAhora,
  };
}

function analizar(item) {
  const descripcion = clean(item.description);
  const sinDescripcionUtil = descripcion.length < MIN_USEFUL_DESCRIPTION;
  const { autor, mostrabaAutorFalso, esGenericoAhora } = copyDebilAntes(item);
  const despues = buildAutomaticProductShowcase(item);
  if (!despues) return null;

  const textoDespues = JSON.stringify(despues);
  const relleno = FRASES_DE_RELLENO.filter(f => textoDespues.includes(f));

  return {
    id: item.id,
    titulo: clean(item.title),
    autorOriginal: autor || null,
    isbn: clean(item.isbn) || null,
    sinDescripcionUtil,
    autorAusenteOGenerico: esGenericoAhora,
    mostrabaAutorFalso,
    pierdeBloqueAutor: esGenericoAhora,
    pierdeBloqueAudiencia: true, // el bloque de audiencia se omite siempre ahora
    pierdeDestacadosDeRelleno: despues.highlights.length < 3,
    conservaDescripcionReal: !sinDescripcionUtil,
    destacadosReales: despues.highlights.length,
    datosDeEdicion: despues.editionFacts.length,
    rellenoResidual: relleno,
  };
}

function esBibliaOReligion(fila) {
  return /biblia|reina.?valera|evangelio|salmos|test?amento|catecismo|religi/i.test(fila.titulo);
}

async function main() {
  console.log('Descargando cohorte y catálogo…');
  const [cohorte, catalogo] = await Promise.all([
    fetchJson(SHOWCASE_COHORT_V2_URL),
    fetchJson(CATALOG_URL),
  ]);

  // La cohorte publica { schema_version, total, ids: [...] } — NO `items`.
  // Se reutiliza el normalizador oficial en vez de reimplementar el formato:
  // así el audit no se desincroniza si el esquema cambia.
  const normalizada = normalizeShowcaseCohort(cohorte);
  if (!normalizada) {
    throw new Error('La cohorte descargada no pasó normalizeShowcaseCohort(): esquema inesperado.');
  }
  console.log(`  cohorte ${normalizada.source}: ${normalizada.total} ids`);

  const items = (Array.isArray(catalogo?.items) ? catalogo.items : [])
    .filter(item => normalizada.ids.has(String(item?.id || '').toUpperCase()));
  console.log(`  cruzados con catálogo activo: ${items.length}`);

  const filas = items.map(analizar).filter(Boolean);
  if (filas.length === 0) {
    throw new Error(
      `La cohorte tiene ${normalizada.total} ids pero ninguno cruzó con el catálogo activo ` +
      `(${(catalogo?.items || []).length} items). Probable desfasaje entre cohorte y catálogo.`,
    );
  }

  const cuenta = predicado => filas.filter(predicado).length;
  const metricas = {
    fichasAnalizadas: filas.length,
    sinDescripcionUtil: cuenta(f => f.sinDescripcionUtil),
    autorAusenteOGenerico: cuenta(f => f.autorAusenteOGenerico),
    mostrabanAutorFalso: cuenta(f => f.mostrabaAutorFalso),
    pierdenBloqueAutor: cuenta(f => f.pierdeBloqueAutor),
    pierdenBloqueAudiencia: cuenta(f => f.pierdeBloqueAudiencia),
    pierdenDestacadosDeRelleno: cuenta(f => f.pierdeDestacadosDeRelleno),
    conservanDescripcionReal: cuenta(f => f.conservaDescripcionReal),
    conRellenoResidual: cuenta(f => f.rellenoResidual.length > 0),
  };

  const porGrupo = n => ({
    biblias: filas.filter(esBibliaOReligion).slice(0, n),
    generales: filas.filter(f => !esBibliaOReligion(f) && !f.sinDescripcionUtil).slice(0, n),
    incompletos: filas.filter(f => f.sinDescripcionUtil && f.autorAusenteOGenerico).slice(0, n),
  });
  const muestra = porGrupo(Math.ceil(SAMPLE_SIZE / 3));

  console.log('\n── Métricas de la cohorte ──');
  for (const [k, v] of Object.entries(metricas)) {
    const pct = k === 'fichasAnalizadas' ? '' : ` (${((v / filas.length) * 100).toFixed(1)}%)`;
    console.log(`  ${k.padEnd(30)} ${String(v).padStart(6)}${pct}`);
  }

  if (metricas.conRellenoResidual > 0) {
    console.error(`\nERROR: ${metricas.conRellenoResidual} fichas todavía contienen frases de relleno.`);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const destino = `${OUTPUT_DIR}/fichas-quality-audit-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(destino, JSON.stringify({ metricas, muestra, filas }, null, 2));
  console.log(`\nEscrito: ${destino}`);

  process.exitCode = metricas.conRellenoResidual > 0 ? 1 : 0;
}

main().catch(error => {
  console.error(`fichas-quality-audit falló: ${error.message}`);
  process.exitCode = 1;
});
