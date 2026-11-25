#!/usr/bin/env node
/**
 * Listado de TODO lo que pidieron clientes reales, para estudiarlo con Seba:
 *   1. Pedidos del formulario "Pedir un libro" (book_requests).
 *   2. Avisos de stock pedidos (stock_waitlist): solo el libro, nunca el correo.
 *   3. Búsquedas del catálogo sin resultados (search_misses), sin el ruido: las
 *      búsquedas de prueba y los textos de género o categoría que el sitio mismo
 *      mandaba al buscador desde las fichas.
 *
 * Todo en solo lectura. El repo es público: el contenido NO se imprime en el log;
 * se escribe en artifacts/busquedas/ y lo manda por correo el workflow.
 *
 *   node scripts/ops/busquedas-export.mjs        (CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { query } from '../reports/weekly/fetch-d1.mjs';
import { normalizeSearchMiss } from '../../functions/_shared/search-misses.js';

const OUT_DIR = 'artifacts/busquedas';
const RUIDO = new Set(['zzzinexistente999', 'search term string']);
const CATALOGO_URL = 'https://pub-b2b408811ae24e3da04cda79c6ff084d.r2.dev/catalog.json';
const CATEGORIAS_URL = 'https://www.amadolibros.com/data/active-categories.json';

/** Temas para agrupar lo que se busca (palabras sin tildes, en minúscula). */
export const TEMAS = [
    ['Tarot, oráculos y cartas', /\b(tarot|oraculo|oraculos|lenormand|cartas|baraja|mazo)\b/],
    ['Psicología y psicoanálisis', /\b(psicolog\w*|psicoanal\w*|freud|jung|lacan|terapia|ansiedad|duelo|emocion\w*)\b/],
    ['Biblias y religión', /\b(biblia|biblias|reina valera|catolic\w*|evangel\w*|espiritu\w*|dios|jesus)\b/],
    ['Inglés e idiomas', /\b(ingles|english|cambridge|oxford|idioma\w*|frances|aleman|portugues|italiano|gramatica)\b/],
    ['Manga, cómics e infantil', /\b(manga|anime|comic\w*|infantil\w*|cuento\w*|ninos|ninas|juvenil)\b/],
    ['Medicina, salud y ciencias', /\b(medicina|anatomia|enfermeria|fisiolog\w*|quimica|fisica|matematica\w*|biolog\w*)\b/],
    ['Educación y docentes', /\b(educacion|docente\w*|maestr\w*|didactica|pedagog\w*|planificacion)\b/],
    ['Derecho, economía y gestión', /\b(derecho|codigo|ley|contab\w*|economia|administracion|gestion|marketing)\b/],
    ['Literatura y novelas', /\b(novela\w*|poesia|literatura|cuento|narrativa|saga)\b/],
];

/** Géneros y categorías del propio sitio, normalizados como las búsquedas guardadas. */
export function generosNormalizados(items = [], categorias = null) {
    const set = new Set();
    const add = valor => {
        const n = normalizeSearchMiss(valor);
        if (n && n.length >= 3) set.add(n);
        // La ficha mostraba el recorrido completo con " > " o "/": cada tramo también cuenta.
        for (const parte of String(valor ?? '').split(/[>/]/)) {
            const p = normalizeSearchMiss(parte);
            if (p && p.length >= 3) set.add(p);
        }
    };
    for (const item of items) {
        add(item?.bibliographic?.genre);
        add(item?.category_name);
    }
    for (const cat of categorias?.categories || []) {
        add(cat?.name);
        for (const sub of cat?.subcategories || []) add(sub?.name);
    }
    return set;
}

export function limpiar(filas, { generos = new Set() } = {}) {
    return filas
        .map(f => ({ date: String(f.date), query: String(f.query), count: Number(f.count) || 0 }))
        .filter(f => f.query && f.count > 0 && !RUIDO.has(f.query) && !generos.has(f.query));
}

function lunesDe(fecha) {
    const d = new Date(`${fecha}T00:00:00Z`);
    const dia = (d.getUTCDay() + 6) % 7; // lunes = 0
    d.setUTCDate(d.getUTCDate() - dia);
    return d.toISOString().slice(0, 10);
}

export function resumir(filas) {
    const porTexto = new Map();
    const porSemana = new Map();
    for (const f of filas) {
        const t = porTexto.get(f.query) || { query: f.query, veces: 0, dias: new Set(), primera: f.date, ultima: f.date };
        t.veces += f.count; t.dias.add(f.date);
        if (f.date < t.primera) t.primera = f.date;
        if (f.date > t.ultima) t.ultima = f.date;
        porTexto.set(f.query, t);
        const sem = lunesDe(f.date);
        const s = porSemana.get(sem) || { semana: sem, veces: 0, textos: new Set() };
        s.veces += f.count; s.textos.add(f.query);
        porSemana.set(sem, s);
    }
    const textos = [...porTexto.values()].sort((a, b) => b.veces - a.veces || a.query.localeCompare(b.query));
    const semanas = [...porSemana.values()].sort((a, b) => a.semana.localeCompare(b.semana));
    const temas = TEMAS.map(([nombre, re]) => {
        const hit = textos.filter(t => re.test(t.query));
        return { nombre, veces: hit.reduce((s, t) => s + t.veces, 0), textos: hit.length, ejemplos: hit.slice(0, 4).map(t => t.query) };
    }).filter(t => t.veces > 0).sort((a, b) => b.veces - a.veces);
    const isbn = textos.filter(t => /^(97[89])?\d{9}[\dx]$/.test(t.query.replace(/[\s-]/g, '')));
    return { textos, semanas, temas, isbn };
}

const celda = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
const dia = iso => String(iso ?? '').slice(0, 10);

export function aMarkdown(filas, { generado = new Date(), pedidos = [], avisos = [], descartadas = 0 } = {}) {
    const r = resumir(filas);
    const total = filas.reduce((s, f) => s + f.count, 0);
    const fechas = filas.map(f => f.date).sort();
    const repetidas = r.textos.filter(t => t.veces >= 2);
    const unicas = r.textos.filter(t => t.veces === 1);
    const L = [];
    L.push('# Lo que pidieron clientes reales: listado para estudiar');
    L.push('');
    L.push(`Generado el ${generado.toISOString().slice(0, 10)}. Búsquedas del ${fechas[0] || '-'} al ${fechas.at(-1) || '-'}.`);
    L.push('');
    L.push(`- Pedidos con el formulario «Pedir un libro»: **${pedidos.length}**`);
    L.push(`- Avisos de stock pedidos: **${avisos.length}**`);
    L.push(`- Búsquedas sin resultados de clientes: **${total}** (${r.textos.length} textos distintos, ${repetidas.length} repetidos y ${unicas.length} de una sola vez)`);
    L.push(`- Ya se descartaron ${descartadas} búsquedas que eran ruido: textos de género o categoría que las fichas mandaban al buscador, y pruebas de nuestros controles.`);
    L.push(`- ISBN buscados: ${r.isbn.length}`);
    L.push('');
    L.push('## 1. Pedidos del formulario «Pedir un libro» (lo más parecido a un pedido de compra)');
    L.push('');
    if (pedidos.length) {
        L.push('| Fecha | Tipo | Qué busca | Autor o ISBN | Formato | Idioma | Presupuesto |');
        L.push('| --- | --- | --- | --- | --- | --- | --- |');
        for (const p of pedidos) {
            L.push(`| ${dia(p.created_at)} | ${celda(p.request_type)} | ${celda(p.query)} | ${celda(p.author_isbn)} | ${celda(p.format)} | ${celda(p.language)} | ${p.budget_uyu ? `$${p.budget_uyu}` : ''} |`);
        }
    } else {
        L.push('_Sin pedidos registrados._');
    }
    L.push('');
    L.push('## 2. Avisos de stock: gente que pidió que le avisemos cuando vuelva un libro');
    L.push('');
    if (avisos.length) {
        const porLibro = new Map();
        for (const a of avisos) {
            const k = celda(a.product_title) || celda(a.product_id);
            const x = porLibro.get(k) || { libro: k, pedidos: 0, ultimo: dia(a.created_at) };
            x.pedidos += 1;
            if (dia(a.created_at) > x.ultimo) x.ultimo = dia(a.created_at);
            porLibro.set(k, x);
        }
        L.push('| Libro | Pedidos | Último |');
        L.push('| --- | --- | --- |');
        for (const x of [...porLibro.values()].sort((a, b) => b.pedidos - a.pedidos || a.libro.localeCompare(b.libro))) {
            L.push(`| ${x.libro} | ${x.pedidos} | ${x.ultimo} |`);
        }
    } else {
        L.push('_Sin avisos._');
    }
    L.push('');
    L.push('## 3. Búsquedas repetidas (de mayor a menor)');
    L.push('');
    L.push('| Búsqueda | Veces | Días | Primera vez | Última |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const t of repetidas) L.push(`| ${celda(t.query)} | ${t.veces} | ${t.dias.size} | ${t.primera} | ${t.ultima} |`);
    L.push('');
    L.push(`## 4. Buscadas una sola vez (${unicas.length})`);
    L.push('');
    L.push('Suelen ser títulos exactos.');
    L.push('');
    for (const t of unicas) L.push(`- ${t.query}`);
    L.push('');
    L.push('## 5. Por tema (agrupado por palabras)');
    L.push('');
    L.push('| Tema | Búsquedas | Textos | Ejemplos |');
    L.push('| --- | --- | --- | --- |');
    for (const t of r.temas) L.push(`| ${t.nombre} | ${t.veces} | ${t.textos} | ${celda(t.ejemplos.join('; '))} |`);
    L.push('');
    L.push('## 6. Por semana');
    L.push('');
    L.push('| Semana (lunes) | Búsquedas | Textos distintos |');
    L.push('| --- | --- | --- |');
    for (const s of r.semanas) L.push(`| ${s.semana} | ${s.veces} | ${s.textos.size} |`);
    L.push('');
    L.push('_Sin IP, sesión, correo ni teléfono. Las búsquedas se guardan en minúscula y sin tildes._');
    return `${L.join('\n')}\n`;
}

async function jsonDe(url) {
    try {
        const res = await fetch(url);
        return res.ok ? await res.json() : null;
    } catch { return null; }
}

async function main() {
    // En fila, no a la vez: cada consulta usa `npx wrangler` y dos instalaciones en paralelo
    // se pisan en la caché de npx (falló con "spawn sh ENOENT").
    const crudas = await query('SELECT date, query, count FROM search_misses ORDER BY date');
    const pedidos = await query('SELECT created_at, request_type, query, author_isbn, format, language, budget_uyu FROM book_requests ORDER BY created_at DESC').catch(() => []);
    const avisos = await query('SELECT product_id, product_title, created_at FROM stock_waitlist ORDER BY created_at DESC').catch(() => []);
    const catalogo = await jsonDe(CATALOGO_URL);
    const categorias = await jsonDe(CATEGORIAS_URL);
    const generos = generosNormalizados(catalogo?.items || [], categorias);
    const todas = crudas.map(f => ({ date: String(f.date), query: String(f.query), count: Number(f.count) || 0 }));
    const filas = limpiar(todas, { generos });
    const descartadas = todas.reduce((s, f) => s + f.count, 0) - filas.reduce((s, f) => s + f.count, 0);
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(`${OUT_DIR}/lo-que-pidieron-clientes.md`, aMarkdown(filas, { pedidos, avisos, descartadas }));
    console.log(`Listo: ${filas.length} filas de búsquedas, ${pedidos.length} pedidos, ${avisos.length} avisos (el contenido no se imprime: el repo es público).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch(error => { console.error('busquedas-export:', error?.message || error); process.exit(1); });
}
