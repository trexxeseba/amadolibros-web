// Cotización de una muestra de Amado Vintage (sólo lee, no cambia nada).
//
//   node precio-ganador/src/cotizar.mjs --cuenta vintage --estado DIR --salida DIR [--muestra 10] [--costos DIR]
//
// Responde con datos: "¿de verdad podemos competir?". Toma tres grupos al azar:
//   A. cualquier publicación activa (cómo estamos en general),
//   B. publicaciones que el sistema bajó (¿nos sigue quedando margen?),
//   C. publicaciones que pierden la ficha y no bajamos (¿se podía competir?).
// A cada una le pasa el MISMO cotizador del publicador (costo del libro puesto en Uruguay
// con la lista de SBS y la política aprobada) y calcula qué nos queda a nuestro precio, al
// precio original y si igualáramos al ganador (99 %). También dice quién gana y si entrega
// de inmediato. Todo se guarda en el repo privado; el registro de la corrida sólo lleva conteos.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CUENTAS } from './config.mjs';
import { fuenteTokenD1 } from './token.mjs';
import { crearCliente } from './ml.mjs';
import { idsActivos, detalle } from './publicaciones.mjs';
import { cargarCotizadorVintage } from './costos-vintage.mjs';
import { todas } from './cotizar-todas.mjs';
import { entregaDe, ofertasCatalogo, vendedorDelGanador, nuevoCacheVendedores } from './competencia.mjs';

// Parte pura (con tests): qué decir de una publicación.
export function veredicto(f, { piso = 1200, margenPiso = 0.18, excluidos = new Set() } = {}) {
  if (f.sin_costo) return 'sin costo conocido (otra fuente)';
  if (f.estado === 'winning') return 'ya ganamos';
  if (f.estado === 'sharing_first_place') return 'compartimos el primer lugar';
  if (f.estado !== 'competing') return f.estado === 'listed' ? 'no compite (tiempo de entrega)' : `no compite (${f.estado || 'sin estado'})`;
  if (excluidos.has(String(f.ganador_vendedor ?? '').toLowerCase())) return `no competir: gana ${f.ganador_vendedor}`;
  if (f.ganador_entrega === 'inmediato') return 'no se gana por precio: el ganador entrega de inmediato';
  if (f.objetivo < piso) return `bajo el piso de ${piso}`;
  if (f.queda_objetivo <= 0) return 'perderíamos plata';
  if (f.sobre_costo_objetivo < margenPiso * 100) return `margen flaco (menos de ${Math.round(margenPiso * 100)} %)`;
  return 'se puede competir';
}

// Cuántas publicaciones de Hermes/Arnoia hay por prefijo de SKU (sólo para el registro).
export function contarPrefijos(items) {
  const otras = [...items.values()].filter(i => i.status === 'active' && /^(HERMES|ARNOIA)-/.test(String(i.seller_custom_field ?? '')));
  return otras.reduce((a, i) => { const p = String(i.seller_custom_field).split('-')[0] + (i.catalog_listing ? '_catalogo' : '_normal'); a[p] = (a[p] ?? 0) + 1; return a; }, {});
}

export const mediana = a => { const o = a.filter(Number.isFinite).sort((x, y) => x - y); return o.length ? o[Math.floor(o.length / 2)] : null; };
export function mezclar(a) { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; }

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d = null) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
  const cuenta = CUENTAS[opt('cuenta', 'vintage')];
  if (!cuenta || cuenta.clave !== 'vintage') { console.error('Sólo para vintage'); process.exit(2); }
  const N = Number(opt('muestra', 10)), dirEstado = opt('estado', 'state'), salida = opt('salida', 'salida');
  const excluidos = new Set((cuenta.vendedoresExcluidos ?? []).map(v => String(v).toLowerCase()));

  const ml = crearCliente(fuenteTokenD1(cuenta), { concurrencia: 4 });
  const yo = await ml.get('/users/me');
  if (String(yo?.id) !== cuenta.sellerId) throw new Error('token_de_otra_cuenta');
  const { cotizar, info } = await cargarCotizadorVintage({ costosDir: opt('costos', null) });
  console.log('Cotizador listo:', JSON.stringify({ renglones: info.renglones, dias_lista: info.dias_lista, arnoia: info.costos_arnoia, celesa: info.costos_celesa }));
  console.log('Listas en D1:', JSON.stringify(info.feeds));

  const ids = await idsActivos(ml, cuenta.sellerId);
  const items = await detalle(ml, ids);
  console.log('Publicaciones de Hermes/Arnoia:', JSON.stringify(contarPrefijos(items)));
  const sbs = [...items.values()].filter(i => i.status === 'active' && i.catalog_listing && cotizar(i));
  console.log(`Activas ${items.size}; con costo conocido y ficha de catálogo ${sbs.length} (Arnoia ${sbs.filter(i => cotizar(i)?.fuente === 'arnoia').length}, Celesa ${sbs.filter(i => cotizar(i)?.fuente === 'celesa').length})`);

  let estado = { publicaciones: {} };
  try { estado = JSON.parse(readFileSync(join(dirEstado, 'vintage.json'), 'utf8')); } catch {}
  const bajadas = Object.entries(estado.publicaciones ?? {}).filter(([id, e]) => Number(e.precio_aplicado) < Number(e.precio_original) && items.get(id)?.status === 'active' && cotizar(items.get(id)));

  const cacheV = nuevoCacheVendedores(), cacheEntrega = new Map();
  async function armar(grupo, item, original = null) {
    const c = cotizar(item);
    const f = { grupo, id: item.id, titulo: String(item.title ?? '').slice(0, 70), precio: item.price, original, sin_costo: !c };
    let p = null;
    try { p = await ml.get(`/items/${item.id}/price_to_win?version=v2`); } catch { /* sin dato */ }
    f.estado = String(p?.status ?? '');
    f.ganador_precio = p?.price_to_win ?? null;
    f.ganador_item = p?.winner?.item_id ?? null;
    if (f.estado === 'competing' && f.ganador_item) {
      const v = await vendedorDelGanador(ml, item.catalog_product_id, f.ganador_item, cacheV).catch(() => null);
      f.ganador_vendedor = v?.nickname ?? null;
      f.ganador_vendedor_id = v?.id ?? null;
      f.ganador_entrega = await entregaDe(ml, f.ganador_item, cacheEntrega);
    }
    if (item.catalog_product_id) {
      try {
        const o = (await ofertasCatalogo(ml, item.catalog_product_id)).filter(x => String(x.seller_id) !== cuenta.sellerId && Number.isFinite(Number(x.price)));
        f.mas_barato_otro = o.length ? Math.min(...o.map(x => Number(x.price))) : null;
        f.ofertas_otros = o.length;
      } catch { /* sin dato */ }
    }
    if (c) {
      Object.assign(f, { fuente: c.fuente, costo: Math.round(c.costo), precio_lista: c.precio_lista, piso_18: c.piso_18, comision: c.comision,
        queda_hoy: c.queda(item.price), sobre_costo_hoy: c.sobre_costo(item.price) });
      if (original) Object.assign(f, { queda_original: c.queda(original), sobre_costo_original: c.sobre_costo(original) });
      if (f.ganador_precio != null) {
        f.objetivo = Math.floor(Number(f.ganador_precio) * 0.99 + 1e-9);
        f.queda_objetivo = c.queda(f.objetivo); f.sobre_costo_objetivo = c.sobre_costo(f.objetivo);
      }
    }
    f.veredicto = veredicto(f, { piso: cuenta.minimo ?? 1200, margenPiso: info.margen_piso ?? 0.18, excluidos });
    return f;
  }

  if (opt('todas', null) !== null) {
    await todas({ ml, cuenta, items, cotizar, armar, info, estado, filasPath: opt('filas', 'estado/ultima/vintage-filas.json'), salida, cacheV });
    return;
  }

  const A = [], B = [], C = [];
  for (const it of mezclar(sbs).slice(0, N)) A.push(await armar('A', it));
  for (const [id, e] of mezclar(bajadas).slice(0, N)) B.push(await armar('B', items.get(id), Number(e.precio_original)));
  // C: al azar entre las que pierden la ficha y el sistema no tocó (revisa hasta 700 al azar).
  let revisadas = 0;
  for (const it of mezclar(sbs.filter(i => !estado.publicaciones?.[i.id]))) {
    if (C.length >= N || revisadas++ >= 700) break;
    let p = null; try { p = await ml.get(`/items/${it.id}/price_to_win?version=v2`); } catch { continue; }
    if (p?.status === 'competing') C.push(await armar('C', it));
  }

  const resumen = g => {
    const con = g.filter(f => !f.sin_costo), comp = g.filter(f => f.estado === 'competing');
    return { n: g.length, con_costo: con.length, pierden: comp.length, ganan_o_comparten: g.filter(f => f.estado === 'winning' || f.estado === 'sharing_first_place').length,
      no_compiten: g.filter(f => f.estado !== 'competing' && f.estado !== 'winning' && f.estado !== 'sharing_first_place').length,
      se_puede_competir: g.filter(f => f.veredicto === 'se puede competir').length,
      mediana_queda_hoy: mediana(con.map(f => f.queda_hoy)), mediana_sobre_costo_hoy: mediana(con.map(f => f.sobre_costo_hoy)),
      mediana_sobre_costo_si_igualamos: mediana(comp.map(f => f.sobre_costo_objetivo)),
      veredictos: g.reduce((a, f) => (a[f.veredicto] = (a[f.veredicto] ?? 0) + 1, a), {}) };
  };
  const out = { fecha: new Date().toISOString(), info, grupos: { A: resumen(A), B: resumen(B), C: resumen(C) }, filas: [...A, ...B, ...C] };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'vintage-cotizacion.json'), JSON.stringify(out, null, 2));
  writeFileSync(join(salida, 'vintage-cotizacion.md'), markdown(out));
  console.log('Cotización:', JSON.stringify(Object.fromEntries(Object.entries(out.grupos).map(([k, v]) => [k, { n: v.n, pierden: v.pierden, se_puede_competir: v.se_puede_competir }]))));
}

export function markdown(o) {
  const l = [`# Cotización de Vintage · ${o.fecha}`, '',
    `Lista de SBS del ${String(o.info.lista_sbs).slice(0, 10)} (${o.info.dias_lista} días), comisión de Mercado Libre ${Math.round(o.info.comision * 100)} %, margen publicado ${Math.round(o.info.margen_publicado * 100)} %, margen mínimo de piso ${Math.round(o.info.margen_piso * 100)} %, entrega ${o.info.entrega_dias} días.`,
    '"Queda" = precio x (1 - comisión) - costo (el libro puesto en Uruguay con flete, mano de obra y envío). "Sobre costo" = queda / costo.', ''];
  const nombres = { A: 'A. Al azar entre todas las activas', B: 'B. Publicaciones que bajó el sistema', C: 'C. Pierden la ficha y no las tocamos' };
  for (const g of ['A', 'B', 'C']) {
    const filas = o.filas.filter(f => f.grupo === g);
    l.push(`## ${nombres[g]}`, '', '```json', JSON.stringify(o.grupos[g], null, 1), '```', '',
      '| Publicación | Hoy | Original | Estado | Ganador | Vendedor | Entrega | Costo | Lista | Piso 18 % | Queda hoy | Si igualamos (99 %) | Veredicto |', '|---|---:|---:|---|---:|---|---|---:|---:|---:|---|---|---|');
    for (const f of filas) l.push(`| [${f.id}](https://articulo.mercadolibre.com.uy/${f.id.replace('MLU', 'MLU-')}) ${f.titulo.slice(0, 38).replace(/\|/g, '/')} | ${f.precio} | ${f.original ?? ''} | ${f.estado} | ${f.ganador_precio ?? ''} | ${f.ganador_vendedor ?? ''} | ${f.ganador_entrega ?? ''} | ${f.costo ?? ''} | ${f.precio_lista ?? ''} | ${f.piso_18 ?? ''} | ${f.queda_hoy ?? ''} (${f.sobre_costo_hoy ?? ''} %) | ${f.objetivo ? `${f.objetivo}: queda ${f.queda_objetivo} (${f.sobre_costo_objetivo} %)` : ''} | ${f.veredicto} |`);
    l.push('');
  }
  return l.join('\n') + '\n';
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error('Cotización fallida:', e?.code ?? e?.message ?? 'error'); process.exit(1); });
