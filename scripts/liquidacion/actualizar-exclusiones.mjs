#!/usr/bin/env node
/**
 * Actualiza las exclusiones de data/liquidacion.json desde el último reporte
 * del motor Precio Ganador (rama `estado/precio-ganador`) y regenera el
 * módulo que leen las Functions (functions/_shared/liquidacion-data.js).
 *
 * Uso:
 *   git fetch origin estado/precio-ganador
 *   node scripts/liquidacion/actualizar-exclusiones.mjs [--ref origin/estado/precio-ganador]
 *   node scripts/liquidacion/actualizar-exclusiones.mjs --solo-modulo   (regenera el .js sin leer el motor)
 *
 * Qué toma del motor (solo lectura, no toca Mercado Libre):
 *   - La foto completa más reciente de la cuenta (`pruebas/<corrida>/libros-todas.tsv`):
 *     una línea por publicación activa con su estado de competencia en ML.
 *       winning / sharing_first_place → "gana precio"
 *       not_listed                    → NO se excluye: son publicaciones fuera del catálogo de
 *                                       ML, el motor no ve su competencia y no significa que no
 *                                       tengan (Seba, 5/11/2026: entran a la liquidación)
 *   - `state/libros.json`: las publicaciones que el motor ya bajó al precio ganador
 *     (también cuentan como "gana precio").
 *   - `ultima/libros-filas.json`: la corrida real más reciente. Si una publicación
 *     aparece ahí marcada (compite y pierde), sale de las exclusiones: hoy compite.
 *
 * Y del repo:
 *   - `astro-front/public/data/active-categories.json`: los libros con tema
 *     medicina-salud (en cualquiera de sus rutas) → `excluir.medicos`. Va en el
 *     JSON y no se lee en vivo para que página, carrito y cobro decidan igual.
 *
 * Y del catálogo publicado (o `--catalogo archivo.json`), solo si ya hay lista:
 *   - los ids de la lista publicados hace menos de 90 días, o sin fecha →
 *     `excluir.recientes`. El índice que usa el cobro no trae la fecha de
 *     publicación; por eso se fija acá y no en vivo.
 *
 * La lista de liquidación (`lista.ids`) es de Seba y este script no la toca.
 * Cuando Seba la entregue o la cambie, volver a correr este script.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_PATH = join(ROOT, 'data', 'liquidacion.json');
export const MODULE_PATH = join(ROOT, 'functions', '_shared', 'liquidacion-data.js');
const CATEGORIES_PATH = join(ROOT, 'astro-front', 'public', 'data', 'active-categories.json');
export const MEDICAL_TOPIC = 'medicina-salud';

const GANA = new Set(['winning', 'sharing_first_place']);
// Mercado Libre no informa competencia para las publicaciones fuera del catálogo (not_listed).
// No hay ningún estado que diga "sin competencia", así que esta exclusión queda vacía a propósito.
const SIN_COMPETENCIA = new Set();
const MLU = /^MLU\d+$/;
const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
export const RECENT_DAYS = 90;
const DAY_MS = 86400000;

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Parte pura: arma las exclusiones a partir de los tres archivos del motor. */
export function buildExclusions({ tsv, filas = [], estado = {} }) {
    const gana = new Set();
    const sinCompetencia = new Set();
    const lines = String(tsv || '').trim().split('\n');
    const header = lines.shift()?.split('\t') ?? [];
    const iId = header.indexOf('id');
    const iEstado = header.indexOf('estado');
    if (iId < 0 || iEstado < 0) throw new Error('la foto del motor no tiene columnas id/estado');
    for (const line of lines) {
        const cols = line.split('\t');
        const id = cols[iId];
        if (!MLU.test(id)) continue;
        if (GANA.has(cols[iEstado])) gana.add(id);
        else if (SIN_COMPETENCIA.has(cols[iEstado])) sinCompetencia.add(id);
    }
    const bajadas = Object.keys(estado?.publicaciones ?? {}).filter(id => MLU.test(id));
    for (const id of bajadas) { gana.add(id); sinCompetencia.delete(id); }
    const bajadasSet = new Set(bajadas);
    for (const fila of Array.isArray(filas) ? filas : []) {
        if (!fila?.marcada || bajadasSet.has(fila.id)) continue;
        gana.delete(fila.id);
        sinCompetencia.delete(fila.id);
    }
    const sorted = set => [...set].sort();
    return { gana_precio: sorted(gana), sin_competencia: sorted(sinCompetencia) };
}

/** Ids con el tema médico en cualquiera de sus rutas de categoría. */
export function medicalIds(categoryData, topic = MEDICAL_TOPIC) {
    const ids = [];
    for (const [id, raw] of Object.entries(categoryData?.items ?? {})) {
        if (!MLU.test(id) || !Array.isArray(raw)) continue;
        const paths = raw.length && Array.isArray(raw[0]) ? raw : [raw];
        if (paths.some(path => Array.isArray(path) && path[0] === topic)) ids.push(id);
    }
    return ids.sort();
}

/** Ids de la lista publicados hace menos de `days` días (o sin fecha válida). */
export function recentIds(listIds, catalogItems, now = Date.now(), days = RECENT_DAYS) {
    const startById = new Map((Array.isArray(catalogItems) ? catalogItems : []).map(item => [String(item?.id), item?.start_time]));
    const out = [];
    for (const id of listIds) {
        if (!startById.has(id)) continue; // no está publicado: no entra por stock
        const start = Date.parse(startById.get(id) || '');
        if (!Number.isFinite(start) || now - start < days * DAY_MS) out.push(id);
    }
    return out.sort();
}

/** Módulo JS equivalente al JSON: las Functions no importan JSON en Node ni en wrangler 3. */
export function renderModule(data) {
    return `// ARCHIVO GENERADO por scripts/liquidacion/actualizar-exclusiones.mjs desde data/liquidacion.json.
// No editar a mano: editar el JSON y correr \`node scripts/liquidacion/actualizar-exclusiones.mjs --solo-modulo\`.
export default ${JSON.stringify(data)};
`;
}

function latestSnapshot(ref) {
    const paths = git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter(p => /^pruebas\/[^/]+\/libros-todas\.tsv$/.test(p));
    if (!paths.length) throw new Error(`no hay fotos completas (pruebas/*/libros-todas.tsv) en ${ref}`);
    const dated = paths.map(p => ({ path: p, date: git(['log', '-1', '--format=%cI', ref, '--', p]).trim() }));
    dated.sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
    return dated[0];
}

async function readCatalog(argv) {
    const idx = argv.indexOf('--catalogo');
    if (idx >= 0) return JSON.parse(readFileSync(argv[idx + 1], 'utf8'));
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error(`catálogo no disponible (${res.status}); pasalo con --catalogo archivo.json`);
    return res.json();
}

async function main(argv) {
    const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    if (!argv.includes('--solo-modulo')) {
        const refIdx = argv.indexOf('--ref');
        const ref = refIdx >= 0 ? argv[refIdx + 1] : 'origin/estado/precio-ganador';
        const snap = latestSnapshot(ref);
        const tsv = git(['show', `${ref}:${snap.path}`]);
        const filas = JSON.parse(git(['show', `${ref}:ultima/libros-filas.json`]));
        const estado = JSON.parse(git(['show', `${ref}:state/libros.json`]));
        const ex = buildExclusions({ tsv, filas, estado });
        const fuente = `motor Precio Ganador, rama estado/precio-ganador: ${snap.path} (${snap.date}), state/libros.json y ultima/libros-filas.json`;
        data.excluir = {
            ...data.excluir,
            gana_precio: { fuente, criterio: 'estado winning o sharing_first_place en ML, o precio ya bajado por el motor', ids: ex.gana_precio },
            sin_competencia: { fuente, criterio: 'Sin ids a propósito: las publicaciones fuera del catálogo (not_listed) no tienen competencia informada y entran (Seba, 5/11/2026)', ids: ex.sin_competencia },
        };
        data.excluir.medicos = {
            fuente: 'astro-front/public/data/active-categories.json',
            criterio: `tema ${MEDICAL_TOPIC} en cualquiera de sus rutas`,
            ids: medicalIds(JSON.parse(readFileSync(CATEGORIES_PATH, 'utf8'))),
        };
        const listIds = (data.lista?.ids ?? []).map(id => String(id).trim().toUpperCase()).filter(id => MLU.test(id));
        const catalog = listIds.length ? await readCatalog(argv) : null;
        data.excluir.recientes = {
            fuente: 'catalog.json (start_time de cada publicación)',
            criterio: `publicada hace menos de ${RECENT_DAYS} días o sin fecha, al correr este script`,
            ids: catalog ? recentIds(listIds, catalog.items) : [],
        };
        data.excluir_actualizado = snap.date;
        writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
        console.log(`gana_precio: ${ex.gana_precio.length} · sin_competencia: ${ex.sin_competencia.length} · medicos: ${data.excluir.medicos.ids.length} · foto: ${snap.path}`);
    }
    writeFileSync(MODULE_PATH, renderModule(data));
    console.log(`módulo regenerado: ${MODULE_PATH}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
}
