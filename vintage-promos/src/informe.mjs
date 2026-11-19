// Informe de SOLO LECTURA de promociones y cupones de Amado Vintage (2341378249).
// No escribe nada en Mercado Libre: usa únicamente GET. Antes de leer verifica con
// Mercado Libre quién es el dueño del token (/users/me) y corta si no es Vintage.
//
// Uso: node vintage-promos/src/informe.mjs <archivo-detalle.json>
// Variables (opcionales): LIMITE_ITEMS (5000), PAGINAS_POR_CAMPANA (3), MUESTRA_PROMOS (60).
// El log lleva sólo agregados; el detalle por libro va al archivo (no se imprime).
import fs from 'node:fs/promises';
import { CUENTAS, fechaMontevideo } from '../../precio-ganador/src/config.mjs';
import { fuenteTokenD1 } from '../../precio-ganador/src/token.mjs';
import { crearCliente } from '../../precio-ganador/src/ml.mjs';
import { idsActivos, detalle } from '../../precio-ganador/src/publicaciones.mjs';
import { cargarPisosVintage } from '../../precio-ganador/src/costos-vintage.mjs';
import { exigirVintage } from '../../hermes-monitor/guardia.mjs';
import { resumenMargen, evaluarEntrada, resumenCampana, armarResumen, maniobra } from './logica.mjs';

const V2 = 'app_version=v2';
const CUENTA = CUENTAS.vintage;
const salida = process.argv[2] ?? 'informe-vintage-promos.json';
const LIMITE_ITEMS = Number(process.env.LIMITE_ITEMS) || 5000;
const PAGINAS = Number(process.env.PAGINAS_POR_CAMPANA) || 3;
const MUESTRA = Number(process.env.MUESTRA_PROMOS) || 60;
const errores = [];
const anotar = (donde, e) => errores.push(`${donde}: ${e?.code ?? e?.message ?? 'error'}${e?.status ? ` (${e.status})` : ''}`);

const ml = crearCliente(fuenteTokenD1(CUENTA), { concurrencia: 2 });
const yo = await exigirVintage(ml);
console.log(`Cuenta verificada: ${yo.id} ${yo.nickname ?? ''}`.trim());

// 1) Costo y piso por publicación (misma fuente que Precio Ganador).
const { pisoDe, info: pisos } = await cargarPisosVintage();

// 2) Publicaciones activas.
const ids = await idsActivos(ml, CUENTA.sellerId, { limite: LIMITE_ITEMS });
const items = await detalle(ml, ids);
const libros = [];
for (const it of items.values()) {
  if (it.status !== 'active' || it.currency_id !== 'UYU' || !(it.price > 0)) continue;
  libros.push({ id: it.id, precio: it.price, piso: pisoDe(it), conDescuento: it.original_price !== null && it.original_price !== undefined });
}
const margen = resumenMargen(libros);
const porId = new Map(libros.map(l => [l.id, l]));

// 3) Campañas y cupones de la cuenta.
let promos = [];
try {
  const d = await ml.get(`/seller-promotions/users/${CUENTA.sellerId}?${V2}`);
  promos = Array.isArray(d) ? d : Array.isArray(d?.results) ? d.results : [];
} catch (e) { anotar(e?.status === 401 || e?.status === 403 ? 'promociones_sin_permiso_del_token' : 'lista_de_promociones', e); }

const campanas = [], detalleCampanas = [];
for (const promo of promos.filter(p => p?.id && p?.type)) {
  const evaluaciones = [];
  let cursor = null;
  try {
    for (let pagina = 0; pagina < PAGINAS; pagina++) {
      const q = new URLSearchParams({ promotion_type: promo.type, app_version: 'v2', limit: '50' });
      if (cursor) { q.set('search_after', cursor); q.set('searchAfter', cursor); }
      const r = await ml.get(`/seller-promotions/promotions/${encodeURIComponent(promo.id)}/items?${q}`);
      const lista = Array.isArray(r?.results) ? r.results : Array.isArray(r) ? r : [];
      for (const entrada of lista) {
        const libro = porId.get(entrada?.id);
        const ev = libro ? evaluarEntrada({ promo, entrada, precio: libro.precio, piso: libro.piso }) : { estado: 'fuera_de_muestra' };
        evaluaciones.push(ev);
        if (libro) detalleCampanas.push({ promocion: promo.id, tipo: promo.type, item: entrada.id, estadoEntrada: entrada.status ?? null, precio: libro.precio, piso: libro.piso, ...ev });
      }
      cursor = r?.paging?.searchAfter ?? r?.paging?.search_after ?? null;
      if (!cursor || !lista.length) break;
    }
  } catch (e) { anotar(`campaña ${promo.type}`, e); }
  campanas.push(resumenCampana(promo, evaluaciones));
}

// 4) Muestra de libros: qué promociones le ofrece hoy Mercado Libre a cada uno
// (los de mayor margen de maniobra primero: son los que podrían entrar).
const muestra = libros.filter(l => !l.conDescuento && maniobra(l)).sort((a, b) => maniobra(b).pct - maniobra(a).pct).slice(0, MUESTRA);
const ofertas = {};
for (const l of muestra) {
  try {
    const d = await ml.get(`/seller-promotions/items/${l.id}?${V2}`);
    for (const e of Array.isArray(d) ? d : []) { const k = `${e?.type ?? '?'}:${e?.status ?? '?'}`; ofertas[k] = (ofertas[k] ?? 0) + 1; }
  } catch (e) { anotar('promos_del_libro', e); break; }
}

const resumen = armarResumen({ fecha: fechaMontevideo(), cuenta: `${yo.id}`, pisos, margen, campanas, errores });
const extra = Object.keys(ofertas).length ? `\n\n## Qué le ofrece Mercado Libre a ${muestra.length} libros con margen (tipo:estado)\n\n${Object.entries(ofertas).map(([k, v]) => `- ${k}: ${v}`).join('\n')}` : '';
console.log(resumen + extra);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, resumen + extra + '\n');
await fs.writeFile(salida, JSON.stringify({ fecha: fechaMontevideo(), pisos, margen, campanas, ofertas_en_muestra: ofertas, detalleCampanas, libros }, null, 1));
console.log(`\nDetalle por libro guardado en ${salida} (no se imprime). Llamadas: ${JSON.stringify(ml.stats)}`);
