#!/usr/bin/env node
/**
 * Arma la lista de liquidación (data/liquidacion.json → lista.ids) desde las
 * ventas reales de Mercado Libre que guarda el Worker en D1.
 *
 * Criterio (el de Seba): libros activos, con stock, publicados hace 2 años o
 * más, SIN ninguna venta en los últimos 730 días. Dos formas de comprobarlo:
 *
 *   1. `sold_quantity` = 0 en la publicación (nunca vendió desde que se publicó,
 *      y se publicó hace 2 años o más). Es la prueba más fuerte.
 *   2. Última venta en D1 anterior a 730 días, pero SOLO si el histórico de D1
 *      cubre los 730 días (si no, "sin venta" no prueba nada y no entra).
 *
 * Además, cualquier venta reciente en D1 saca al libro, aunque sold_quantity
 * sea 0: se busca por ISBN (todas las publicaciones del mismo ISBN) y por
 * título, porque alrededor del 5 % de las líneas de venta no tienen ISBN. Si no
 * se puede verificar un libro, NO entra: ante la duda, no se rebaja un libro
 * que quizá se vende.
 *
 * Solo lee: el catálogo público y POST /sales/query del Worker (la clave llega
 * por la variable SYNC_SECRET, nunca se imprime). El repo es público: el log
 * muestra solo conteos, jamás ventas, títulos ni ISBN.
 *
 * Uso (lo corre .github/workflows/liquidacion-lista.yml):
 *   WORKER=https://... SYNC_SECRET=... node scripts/liquidacion/armar-lista.mjs [--catalogo archivo.json]
 *
 * Escribe data/liquidacion.json (lista.*) y data/liquidacion-resumen.json
 * (solo conteos). Las exclusiones (médicos, recientes, gana precio, sin
 * competencia) las aplica después actualizar-exclusiones.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bookIsbn } from '../../worker-sync/isbn.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA_PATH = join(ROOT, 'data', 'liquidacion.json');
const SUMMARY_PATH = join(ROOT, 'data', 'liquidacion-resumen.json');
const CATALOG_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const DAY_MS = 86400000;
// ISBN válido solo para preguntarle al Worker desde cuándo tiene ventas.
const ISBN_SONDA = '9780306406157';

export const SIN_VENTA_DIAS = 730;
export const MIN_PUBLICADO_DIAS = 730;
export const ISBN_BATCH = 50;
// D1 rechaza patrones LIKE de más de 50 caracteres (500 internal_error). El Worker busca
// `%clave%` con el título normalizado (minúsculas, sin acentos ni signos), así que se
// consulta por el comienzo de esa clave: 44 + 2 comodines = 46.
export const TITULO_CLAVE_MAX = 44;
export const TITULO_CLAVE_MIN = 4;
export const MAX_ERRORES_TITULO = 10;

/** Misma normalización que el Worker (publication-policy.normalizedTitle), recortada. */
export function claveTitulo(title, max = TITULO_CLAVE_MAX) {
    return String(title ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, max);
}

/** Activos, con stock y precio, publicados hace MIN_PUBLICADO_DIAS o más. */
export function candidatos(items, now = Date.now(), minDays = MIN_PUBLICADO_DIAS) {
    return (Array.isArray(items) ? items : []).filter(item => {
        if (item?.status !== 'active') return false;
        if (!(Number(item.available_quantity) > 0) || !(Number(item.price) > 0)) return false;
        const start = Date.parse(item.start_time || '');
        return Number.isFinite(start) && now - start >= minDays * DAY_MS;
    });
}

/** ¿El resultado del Worker trae una venta dentro de la ventana? */
export function vendidoEn(result, now = Date.now(), days = SIN_VENTA_DIAS) {
    const last = Date.parse(result?.ultima_venta || '');
    return Number.isFinite(last) && now - last <= days * DAY_MS;
}

/** Nunca vendió desde que se publicó (contador de Mercado Libre). */
export function nuncaVendido(item) {
    return item?.sold_quantity !== null && item?.sold_quantity !== undefined && item.sold_quantity !== ''
        && Number.isFinite(Number(item.sold_quantity)) && Number(item.sold_quantity) === 0;
}

/** La base de ventas tiene que cubrir toda la ventana, si no "sin venta" no prueba nada. */
export function coberturaSuficiente(result, now = Date.now(), days = SIN_VENTA_DIAS) {
    const since = Date.parse(result?.cobertura_desde || '');
    return Number.isFinite(since) && now - since >= days * DAY_MS;
}

async function mapLimit(list, limit, fn) {
    const out = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, list.length) }, async () => {
        while (next < list.length) {
            const i = next++;
            out[i] = await fn(list[i], i);
        }
    }));
    return out;
}

/**
 * Decide qué candidatos entran. `query(body)` = POST /sales/query del Worker.
 * Falla cerrada: cualquier error de consulta tira excepción y no se escribe
 * nada. Un histórico corto no es un error: solo deja afuera a los libros que
 * únicamente se podrían probar con él (los que ya vendieron alguna vez).
 */
export async function evaluar(items, query, { now = Date.now(), concurrency = 2 } = {}) {
    const conteos = {
        candidatos: items.length, con_sold_quantity: 0, nunca_vendidos: 0,
        cobertura_desde: null, cobertura_dias: null, cobertura_completa: false,
        sin_isbn: 0, vendido_por_isbn: 0, titulo_no_verificable: 0, titulo_con_error: 0, vendido_por_titulo: 0,
        no_verificable_por_cobertura: 0, en_lista: 0,
    };

    // 0) Sonda: desde cuándo hay ventas guardadas.
    const sonda = await query({ isbns: [ISBN_SONDA] });
    const base = sonda?.resultados?.[0];
    if (!base || base.error) throw new Error('el Worker no informó la cobertura de ventas');
    const cobertura = Date.parse(base.cobertura_desde || '');
    conteos.cobertura_desde = Number.isFinite(cobertura) ? new Date(cobertura).toISOString().slice(0, 10) : null;
    conteos.cobertura_dias = Number.isFinite(cobertura) ? Math.floor((now - cobertura) / DAY_MS) : null;
    conteos.cobertura_completa = coberturaSuficiente(base, now);

    const conIsbn = [];
    const sinIsbn = [];
    for (const item of items) {
        if (item.sold_quantity !== undefined && item.sold_quantity !== null) conteos.con_sold_quantity++;
        if (nuncaVendido(item)) conteos.nunca_vendidos++;
        const isbn = bookIsbn(item.isbn);
        if (isbn) conIsbn.push({ item, isbn }); else sinIsbn.push(item);
    }

    // 1) Por ISBN, de a 50.
    const isbns = [...new Set(conIsbn.map(c => c.isbn))];
    const lotes = [];
    for (let i = 0; i < isbns.length; i += ISBN_BATCH) lotes.push(isbns.slice(i, i + ISBN_BATCH));
    const porIsbn = new Map();
    await mapLimit(lotes, concurrency, async lote => {
        const data = await query({ isbns: lote });
        if (!Array.isArray(data?.resultados)) throw new Error('respuesta de ventas sin resultados');
        for (const r of data.resultados) {
            if (r.error) throw new Error(`ISBN rechazado por el Worker (${r.error})`);
            porIsbn.set(r.isbn, r);
        }
    });
    const paraTitulo = [];
    for (const c of conIsbn) {
        const r = porIsbn.get(c.isbn);
        if (!r) throw new Error('falta el resultado de un ISBN');
        if (vendidoEn(r, now)) { conteos.vendido_por_isbn++; continue; }
        paraTitulo.push(c.item);
    }
    // Los que nunca vendieron en toda su vida pueden no tener ISBN: se verifican igual por título.
    for (const item of sinIsbn) {
        if (nuncaVendido(item)) paraTitulo.push(item); else conteos.sin_isbn++;
    }

    // 2) Por título, para las ventas que quedaron sin ISBN en D1.
    const enLista = [];
    await mapLimit(paraTitulo, concurrency, async item => {
        const clave = claveTitulo(item.title);
        if (clave.length < TITULO_CLAVE_MIN) { conteos.titulo_no_verificable++; return; }
        let data;
        try {
            data = await query({ titulo: clave });
        } catch (error) {
            if (error?.status === 400) { conteos.titulo_no_verificable++; return; }
            // Un título que el Worker no puede buscar deja afuera a ese libro; si son varios, algo anda mal.
            if (error?.status >= 500 && ++conteos.titulo_con_error <= MAX_ERRORES_TITULO) return;
            throw error;
        }
        if (!Array.isArray(data?.resultados)) throw new Error('respuesta de ventas por título sin resultados');
        if (data.resultados.some(r => vendidoEn(r, now))) { conteos.vendido_por_titulo++; return; }
        // Sin venta reciente en D1: prueba suficiente si nunca vendió o si D1 cubre los 730 días.
        if (nuncaVendido(item) || conteos.cobertura_completa) enLista.push(String(item.id));
        else conteos.no_verificable_por_cobertura++;
    });
    conteos.en_lista = enLista.length;
    return { ids: enLista.sort(), conteos };
}

/** Qué clase de consulta es, para que un error diga dónde falló (sin datos de ventas). */
export function tipoDeConsulta(body) {
    if (body?.titulo !== undefined) return 'titulo';
    return Array.isArray(body?.isbns) && body.isbns.length === 1 ? 'isbn_uno' : 'isbn_lote';
}

export function workerQuery({ worker, secret, fetchFn = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
    return async function query(body) {
        const tipo = tipoDeConsulta(body);
        for (let attempt = 0; attempt < 5; attempt++) {
            const res = await fetchFn(`${worker}/sales/query`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) return res.json();
            if ((res.status === 429 || res.status >= 500) && attempt < 4) {
                await sleep(2000 * (attempt + 1));
                continue;
            }
            // Solo el código de error del Worker (p. ej. internal_error), nunca el cuerpo completo.
            let code = '';
            try { code = String((await res.json())?.error ?? '').replace(/[^a-z0-9_]/gi, '').slice(0, 40); } catch { /* sin cuerpo */ }
            const error = new Error(`el Worker respondió ${res.status} en la consulta ${tipo}${code ? ` (${code})` : ''}`);
            error.status = res.status;
            error.tipo = tipo;
            throw error;
        }
        throw new Error('el Worker no respondió');
    };
}

async function readCatalog(argv) {
    const idx = argv.indexOf('--catalogo');
    if (idx >= 0) return JSON.parse(readFileSync(argv[idx + 1], 'utf8'));
    const res = await fetch(CATALOG_URL);
    if (!res.ok) throw new Error(`catálogo no disponible (${res.status})`);
    return res.json();
}

async function main(argv) {
    const worker = process.env.WORKER;
    const secret = process.env.SYNC_SECRET;
    if (!worker || !secret) throw new Error('faltan WORKER y SYNC_SECRET');
    const catalog = await readCatalog(argv);
    const now = Date.now();
    const activos = (catalog.items ?? []).filter(i => i?.status === 'active');
    const cands = candidatos(catalog.items, now);
    const { ids, conteos } = await evaluar(cands, workerQuery({ worker, secret }), { now });
    const resumen = { generado: new Date(now).toISOString(), catalogo_activo: activos.length, ...conteos };

    const data = JSON.parse(readFileSync(DATA_PATH, 'utf8'));
    data.lista = {
        entregada: new Date(now).toISOString().slice(0, 10),
        criterio: `Activos con stock, publicados hace ${MIN_PUBLICADO_DIAS} días o más y sin ninguna venta en los últimos ${SIN_VENTA_DIAS} días en Mercado Libre: nunca vendieron desde que se publicaron, o D1 (ventas desde ${conteos.cobertura_desde ?? 'fecha desconocida'}) lo prueba. Sin venta reciente por ISBN ni por título. Lo que no se puede verificar no entra.`,
        ids,
    };
    writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(SUMMARY_PATH, `${JSON.stringify(resumen, null, 2)}\n`);
    console.log(JSON.stringify(resumen));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2)).catch(error => { console.error(`armar-lista: ${error.message}`); process.exit(1); });
}
