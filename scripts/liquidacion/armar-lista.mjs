#!/usr/bin/env node
/**
 * Arma la lista de liquidación (data/liquidacion.json → lista.ids) desde las
 * ventas reales de Mercado Libre que guarda el Worker en D1.
 *
 * Criterio (el de Seba): libros activos, con stock, publicados hace 2 años o
 * más, SIN ninguna venta en los últimos 730 días. La venta se busca por ISBN
 * (todas las publicaciones del mismo ISBN) y también por título, porque
 * alrededor del 5 % de las líneas de venta no tienen ISBN. Si no se puede
 * verificar un libro (sin ISBN, título muy corto), NO entra: ante la duda, no
 * se rebaja un libro que quizá se vende.
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

export const SIN_VENTA_DIAS = 730;
export const MIN_PUBLICADO_DIAS = 730;
export const ISBN_BATCH = 50;

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
 * Falla cerrada: cualquier error de consulta o cobertura insuficiente tira
 * excepción y no se escribe nada.
 */
export async function evaluar(items, query, { now = Date.now(), concurrency = 4 } = {}) {
    const conteos = {
        candidatos: items.length, sin_isbn: 0, vendido_por_isbn: 0, titulo_no_verificable: 0,
        vendido_por_titulo: 0, en_lista: 0,
    };
    const conIsbn = [];
    for (const item of items) {
        const isbn = bookIsbn(item.isbn);
        if (isbn) conIsbn.push({ item, isbn }); else conteos.sin_isbn++;
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
            if (!coberturaSuficiente(r, now)) throw new Error('el histórico de ventas no cubre 730 días');
            porIsbn.set(r.isbn, r);
        }
    });
    const sinVentaIsbn = [];
    for (const c of conIsbn) {
        const r = porIsbn.get(c.isbn);
        if (!r) throw new Error('falta el resultado de un ISBN');
        if (vendidoEn(r, now)) conteos.vendido_por_isbn++; else sinVentaIsbn.push(c.item);
    }

    // 2) Por título, para las ventas que quedaron sin ISBN en D1.
    const enLista = [];
    await mapLimit(sinVentaIsbn, concurrency, async item => {
        let data;
        try {
            data = await query({ titulo: String(item.title || '') });
        } catch (error) {
            if (error?.status === 400) { conteos.titulo_no_verificable++; return; }
            throw error;
        }
        if (!Array.isArray(data?.resultados)) throw new Error('respuesta de ventas por título sin resultados');
        if (data.resultados.some(r => vendidoEn(r, now))) { conteos.vendido_por_titulo++; return; }
        enLista.push(String(item.id));
    });
    conteos.en_lista = enLista.length;
    return { ids: enLista.sort(), conteos };
}

function workerQuery({ worker, secret, fetchFn = globalThis.fetch }) {
    return async function query(body) {
        for (let attempt = 0; attempt < 4; attempt++) {
            const res = await fetchFn(`${worker}/sales/query`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (res.ok) return res.json();
            if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
                continue;
            }
            const error = new Error(`el Worker respondió ${res.status}`);
            error.status = res.status;
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
        criterio: `Activos con stock, publicados hace ${MIN_PUBLICADO_DIAS} días o más y sin ninguna venta en los últimos ${SIN_VENTA_DIAS} días en Mercado Libre (por ISBN y por título). Sin ISBN verificable no entran.`,
        ids,
    };
    writeFileSync(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`);
    writeFileSync(SUMMARY_PATH, `${JSON.stringify(resumen, null, 2)}\n`);
    console.log(JSON.stringify(resumen));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main(process.argv.slice(2)).catch(error => { console.error(`armar-lista: ${error.message}`); process.exit(1); });
}
