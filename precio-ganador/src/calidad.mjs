// Desglose de los "objetivos de calidad por lograr" de Mercado Libre (pedido de Seba, 25/11/2026). Sólo lee.
//
//   node precio-ganador/src/calidad.mjs --cuenta libros --salida DIR [--estados active,paused] [--tope 20000]
//
// La pantalla de Publicaciones mostró 5.936 publicaciones con objetivos de calidad, contra 4.134 con
// atributos faltantes que se contaron el 24/11 sobre las activas. Esto lee GET /item/{id}/performance
// de cada publicación y cuenta qué objetivo queda pendiente (atributos, video, fotos, etc.) y en qué estado
// está la publicación. El log sólo lleva conteos (el repo es público); el detalle va al archivo de salida.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';

const PENDIENTE = s => /PENDING|INCOMPLETE|OPPORTUNITY|UNCOMPLETED/i.test(String(s ?? ''));

// De la respuesta de /item/{id}/performance a la lista de objetivos pendientes. Función pura.
export function pendientes(perf) {
  const out = [];
  for (const b of Array.isArray(perf?.buckets) ? perf.buckets : []) {
    for (const v of Array.isArray(b?.variables) ? b.variables : []) {
      const reglas = (Array.isArray(v?.rules) ? v.rules : []).filter(r => PENDIENTE(r?.status));
      if (reglas.length) for (const r of reglas) out.push({ grupo: b.key ?? b.title ?? '?', objetivo: v.key ?? v.title ?? '?', regla: r.key ?? r.wordings?.title ?? '?', titulo: r.wordings?.title ?? v.title ?? null });
      else if (PENDIENTE(v?.status)) out.push({ grupo: b.key ?? b.title ?? '?', objetivo: v.key ?? v.title ?? '?', regla: null, titulo: v.title ?? null });
    }
  }
  return out;
}

// Conteo por objetivo (cuántas publicaciones lo tienen pendiente) y por cantidad de objetivos. Función pura.
export function resumenCalidad(filas) {
  const porObjetivo = {}, porRegla = {}, porCantidad = {}, porEstado = {};
  for (const f of filas) {
    const objs = new Set(f.pendientes.map(p => p.objetivo)), reglas = new Set(f.pendientes.map(p => p.regla ?? p.objetivo));
    for (const o of objs) porObjetivo[o] = (porObjetivo[o] ?? 0) + 1;
    for (const r of reglas) porRegla[r] = (porRegla[r] ?? 0) + 1;
    const n = objs.size; porCantidad[n] = (porCantidad[n] ?? 0) + 1;
    if (n > 0) porEstado[f.estado] = (porEstado[f.estado] ?? 0) + 1;
  }
  return { leidas: filas.length, con_objetivos: filas.filter(f => f.pendientes.length).length, por_estado_con_objetivos: porEstado, por_objetivo: porObjetivo, por_regla: porRegla, por_cantidad: porCantidad };
}

async function ids(ml, sellerId, estado) {
  const out = []; let scroll = null;
  for (let pagina = 0; pagina < 500; pagina++) {
    const d = await ml.get(`/users/${sellerId}/items/search?status=${estado}&search_type=scan&limit=100${scroll ? `&scroll_id=${encodeURIComponent(scroll)}` : ''}`);
    const res = Array.isArray(d?.results) ? d.results : [];
    if (!res.length) break;
    out.push(...res); scroll = d?.scroll_id ?? null;
    if (!scroll) break;
  }
  return [...new Set(out)];
}

async function enParalelo(lista, n, fn) {
  const cola = [...lista];
  await Promise.all(Array.from({ length: n }, async () => { while (cola.length) await fn(cola.shift()); }));
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta')];
  if (!cuenta || cuenta.clave !== 'libros') { console.error('Sólo --cuenta libros'); process.exit(2); }
  const estados = String(opt('estados', 'active,paused')).split(',').filter(Boolean), tope = Number(opt('tope', 20000)), salida = opt('salida', '.');
  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 4 }); // sólo GET en este archivo
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw Object.assign(new Error('token_de_otra_cuenta'), { fatal: true });

  const lista = []; const porEstadoTotal = {};
  for (const e of estados) { const x = await ids(ml, cuenta.sellerId, e); porEstadoTotal[e] = x.length; for (const id of x) lista.push({ id, estado: e }); }
  const filas = []; const http = {}; let claves = null;
  await enParalelo(lista.slice(0, tope), 4, async ({ id, estado }) => {
    try {
      const p = await ml.get(`/item/${id}/performance`);
      http[200] = (http[200] ?? 0) + 1; claves ??= p && typeof p === 'object' ? Object.keys(p) : null;
      filas.push({ id, estado, puntaje: p?.score ?? null, nivel: p?.level_wording ?? p?.level ?? null, pendientes: pendientes(p) });
    } catch (e) { if (e?.fatal || e?.status === 429) throw e; const k = e?.status ?? 0; http[k] = (http[k] ?? 0) + 1; }
  });
  const titulos = {}; for (const f of filas) for (const p of f.pendientes) titulos[p.regla ?? p.objetivo] ??= p.titulo;
  const resumen = { fecha: new Date().toISOString().slice(0, 10), cuenta: cuenta.clave, publicaciones_por_estado: porEstadoTotal, http, claves_respuesta: claves, ...resumenCalidad(filas), titulos };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, `${cuenta.clave}-calidad.json`), JSON.stringify({ resumen, filas }, null, 1));
  console.log(JSON.stringify(resumen)); // sólo conteos y nombres de objetivos: el log es público
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) main().catch(e => { console.error('calidad:', e?.code ?? e?.message); process.exit(1); });
