#!/usr/bin/env node
/**
 * Exporta TODO lo que la gente buscó en la web y no encontró (tabla search_misses de
 * D1, solo lectura) y arma un informe en markdown para analizarlo con Seba.
 *
 * El repo es público: el informe NO se imprime en el log. Se escribe en
 * artifacts/busquedas/ y lo manda por correo el workflow (send-report-email.mjs).
 * No hay IP, sesión ni correo: la tabla guarda solo el texto normalizado y un
 * contador por día.
 *
 *   node scripts/ops/busquedas-export.mjs        (CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { query } from '../reports/weekly/fetch-d1.mjs';

const OUT_DIR = 'artifacts/busquedas';
const RUIDO = new Set(['zzzinexistente999']);

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

export function limpiar(filas) {
    return filas
        .map(f => ({ date: String(f.date), query: String(f.query), count: Number(f.count) || 0 }))
        .filter(f => f.query && f.count > 0 && !RUIDO.has(f.query));
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

const celda = s => String(s).replace(/\|/g, '/');

export function aMarkdown(filas, { generado = new Date() } = {}) {
    const r = resumir(filas);
    const total = filas.reduce((s, f) => s + f.count, 0);
    const desde = filas.length ? filas.map(f => f.date).sort()[0] : '-';
    const hasta = filas.length ? filas.map(f => f.date).sort().at(-1) : '-';
    const repetidas = r.textos.filter(t => t.veces >= 2);
    const unicas = r.textos.filter(t => t.veces === 1);
    const L = [];
    L.push('# Búsquedas sin resultados: todo lo que registró la web');
    L.push('');
    L.push(`Del ${desde} al ${hasta}. Se sacaron las búsquedas de prueba de nuestros controles. Generado el ${generado.toISOString().slice(0, 10)}.`);
    L.push('');
    L.push(`- Búsquedas sin resultados: **${total}**`);
    L.push(`- Textos distintos: **${r.textos.length}** (${repetidas.length} repetidos, ${unicas.length} de una sola vez)`);
    L.push(`- ISBN buscados: ${r.isbn.length}`);
    L.push('');
    L.push('## Por semana');
    L.push('');
    L.push('| Semana (lunes) | Búsquedas | Textos distintos |');
    L.push('| --- | --- | --- |');
    for (const s of r.semanas) L.push(`| ${s.semana} | ${s.veces} | ${s.textos.size} |`);
    L.push('');
    L.push('## Por tema (agrupado por palabras)');
    L.push('');
    L.push('| Tema | Búsquedas | Textos | Ejemplos |');
    L.push('| --- | --- | --- | --- |');
    for (const t of r.temas) L.push(`| ${t.nombre} | ${t.veces} | ${t.textos} | ${celda(t.ejemplos.join('; '))} |`);
    L.push('');
    L.push('## Lo más buscado (repetidos, de mayor a menor)');
    L.push('');
    L.push('| Búsqueda | Veces | Días | Primera vez | Última |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const t of repetidas.slice(0, 80)) L.push(`| ${celda(t.query)} | ${t.veces} | ${t.dias.size} | ${t.primera} | ${t.ultima} |`);
    L.push('');
    L.push(`## Buscados una sola vez (${unicas.length})`);
    L.push('');
    L.push('Suelen ser títulos exactos: es lo más parecido a un pedido de compra.');
    L.push('');
    for (const t of unicas.slice(0, 250)) L.push(`- ${t.query}`);
    L.push('');
    L.push('_Texto normalizado: minúsculas y sin tildes. Sin IP, sesión ni datos personales._');
    return `${L.join('\n')}\n`;
}

export function aCsv(filas) {
    const r = resumir(filas);
    const esc = s => `"${String(s).replace(/"/g, '""')}"`;
    return ['busqueda,veces,dias,primera_vez,ultima_vez',
        ...r.textos.map(t => [esc(t.query), t.veces, t.dias.size, t.primera, t.ultima].join(','))].join('\n') + '\n';
}

async function main() {
    const filas = limpiar(await query('SELECT date, query, count FROM search_misses ORDER BY date'));
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(`${OUT_DIR}/busquedas-sin-resultados.md`, aMarkdown(filas));
    await writeFile(`${OUT_DIR}/busquedas-sin-resultados.csv`, aCsv(filas));
    console.log(`Listo: ${filas.length} filas procesadas (el contenido no se imprime: el repo es público).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch(error => { console.error('busquedas-export:', error?.message || error); process.exit(1); });
}
