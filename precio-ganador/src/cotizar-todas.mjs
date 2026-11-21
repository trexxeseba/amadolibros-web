// Cotización de TODAS las publicaciones de Vintage que pierden la ficha (sólo lee).
// Para cada una: costo con la lista de SBS de hoy, quién gana (vendedor, entrega, reputación),
// qué nos queda si igualamos al 99 % del ganador, y qué pasaría con la regla actual y con una
// regla por margen. El detalle va al repo privado; el registro de la corrida sólo lleva conteos.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const mediana = a => { const o = a.filter(Number.isFinite).sort((x, y) => x - y); return o.length ? o[Math.floor(o.length / 2)] : null; };
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

// Regla vigente: baja si la diferencia es de hasta `umbral` pesos y el objetivo llega al mínimo.
export const reglaActual = (f, { umbral = 400, minimo = 1200 } = {}) =>
  f.estado === 'competing' && f.ganador_entrega !== 'inmediato' && f.objetivo != null && f.precio - f.objetivo <= umbral && f.objetivo >= minimo;
// Regla por margen: baja al 99 % del ganador si no es de entrega inmediata, no está excluido y queda al menos `margen` % sobre costo.
export const reglaMargen = (f, margen, excluidos = new Set()) =>
  f.estado === 'competing' && f.ganador_entrega !== 'inmediato' && !excluidos.has(String(f.ganador_vendedor ?? '').toLowerCase())
  && f.objetivo != null && f.sobre_costo_objetivo != null && f.sobre_costo_objetivo >= margen;

export function agregar(filas, { excluidos = new Set(), umbral = 400, minimo = 1200 } = {}) {
  const comp = filas.filter(f => f.estado === 'competing');
  const con = comp.filter(f => !f.sin_costo && f.objetivo != null);
  const sens = {};
  for (const m of [0, 10, 18, 25, 30]) {
    const sel = con.filter(f => reglaMargen(f, m, excluidos));
    sens[m] = { bajarian: sel.length, mediana_sobre_costo: mediana(sel.map(f => f.sobre_costo_objetivo)), mediana_queda: mediana(sel.map(f => f.queda_objetivo)),
      plata_que_se_resigna_por_venta_mediana: mediana(sel.map(f => f.precio - f.objetivo)) };
  }
  const actual = con.filter(f => reglaActual(f, { umbral, minimo }));
  const porVendedor = new Map();
  for (const f of comp) {
    const k = f.ganador_vendedor_id ?? 'sin dato';
    const v = porVendedor.get(k) ?? { id: k, nickname: f.ganador_vendedor ?? null, n: 0, difs: [], pctDifs: [], viables: 0, bajo_costo: 0, inmediato: 0, a_demanda: 0, margenes: [] };
    v.n++;
    if (f.ganador_precio != null) { v.difs.push(f.precio - f.ganador_precio); v.pctDifs.push(((f.precio - f.ganador_precio) / f.precio) * 100); }
    if (f.sobre_costo_objetivo != null) v.margenes.push(f.sobre_costo_objetivo);
    if (f.veredicto === 'se puede competir') v.viables++;
    if (f.queda_objetivo != null && f.queda_objetivo <= 0) v.bajo_costo++;
    if (f.ganador_entrega === 'inmediato') v.inmediato++; else if (f.ganador_entrega) v.a_demanda++;
    porVendedor.set(k, v);
  }
  const vendedores = [...porVendedor.values()].sort((a, b) => b.n - a.n).map(v => ({ id: v.id, nickname: v.nickname, n: v.n, mediana_dif_pesos: mediana(v.difs),
    mediana_dif_pct: Math.round((mediana(v.pctDifs) ?? 0) * 10) / 10, mediana_sobre_costo_si_igualamos: mediana(v.margenes), viables: v.viables,
    pct_viables: pct(v.viables, v.n), venden_bajo_nuestro_costo: v.bajo_costo, entrega_inmediata: v.inmediato, entrega_a_demanda: v.a_demanda }));
  return {
    pierden: comp.length, con_costo: con.length, sin_costo: comp.length - con.length,
    veredictos: comp.reduce((a, f) => (a[f.veredicto] = (a[f.veredicto] ?? 0) + 1, a), {}),
    regla_actual: { bajarian: actual.length, mediana_sobre_costo: mediana(actual.map(f => f.sobre_costo_objetivo)) },
    sensibilidad_margen: sens, vendedores,
  };
}

export async function perfilVendedor(ml, id) {
  try {
    const u = await ml.get(`/users/${id}`);
    const r = u?.seller_reputation ?? {};
    return { id: String(id), nickname: u?.nickname ?? null, registro: String(u?.registration_date ?? '').slice(0, 10), nivel: r.level_id ?? null, power_seller: r.power_seller_status ?? null,
      ventas_completadas: r.transactions?.completed ?? null, ventas_total: r.transactions?.total ?? null, calificacion_positiva: r.transactions?.ratings?.positive ?? null,
      pais: u?.address?.country ?? u?.country_id ?? null, ubicacion: [u?.address?.city, u?.address?.state].filter(Boolean).join(', ') || null };
  } catch { return { id: String(id), nickname: null }; }
}

export async function todas({ ml, cuenta, items, armar, info, estado, filasPath, salida }) {
  const excluidos = new Set((cuenta.vendedoresExcluidos ?? []).map(v => String(v).toLowerCase()));
  const filasPrev = JSON.parse(readFileSync(filasPath, 'utf8'));
  const ids = (Array.isArray(filasPrev) ? filasPrev : filasPrev.filas).filter(f => f.compite).map(f => f.id).filter(id => items.get(id)?.status === 'active');
  console.log(`Pierden la ficha (según la última corrida): ${ids.length}`);
  const filas = []; let i = 0, hechas = 0;
  const trabajador = async () => {
    for (;;) {
      const id = ids[i++]; if (!id) return;
      try {
        const original = Number(estado.publicaciones?.[id]?.precio_original) || null;
        filas.push(await armar('T', items.get(id), original && original !== items.get(id).price ? original : null));
      } catch { filas.push({ grupo: 'T', id, estado: 'error', veredicto: 'sin dato' }); }
      if (++hechas % 500 === 0) console.log(`Cotizadas ${hechas}/${ids.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, trabajador));
  const agg = agregar(filas, { excluidos, umbral: cuenta.umbral ?? 400, minimo: cuenta.minimo ?? 1200 });
  const perfiles = {};
  for (const v of agg.vendedores.filter(x => x.id !== 'sin dato').slice(0, 30)) perfiles[v.id] = await perfilVendedor(ml, v.id);
  const alcohol = filas.filter(f => /alcohol|tobacco|tabaco/i.test(f.titulo ?? ''));
  const out = { fecha: new Date().toISOString(), info, agregado: agg, perfiles, alcohol_y_tabaco: alcohol, filas };
  mkdirSync(salida, { recursive: true });
  writeFileSync(join(salida, 'vintage-cotizacion-completa.json'), JSON.stringify(out));
  writeFileSync(join(salida, 'vintage-cotizacion-completa.md'), markdownTodas(out));
  console.log('Cotización completa:', JSON.stringify({ pierden: agg.pierden, con_costo: agg.con_costo, regla_actual: agg.regla_actual.bajarian,
    margen18: agg.sensibilidad_margen[18].bajarian, vendedores: agg.vendedores.length }));
}

export function markdownTodas(o) {
  const a = o.agregado, p = o.perfiles;
  const l = [`# Cotización completa de Vintage · ${o.fecha}`, '',
    `Lista de SBS del ${String(o.info.lista_sbs).slice(0, 10)} (${o.info.dias_lista} días), ${o.info.renglones} renglones. Comisión ${Math.round(o.info.comision * 100)} %, margen publicado ${Math.round(o.info.margen_publicado * 100)} %.`,
    `Pierden la ficha: ${a.pierden} (con costo conocido ${a.con_costo}, sin costo ${a.sin_costo}).`, '',
    '## Qué decide cada regla', '', '| Regla | Bajarían | Sobre costo (mediana) |', '|---|---:|---:|',
    `| Actual (diferencia hasta 400 y piso 1.200) | ${a.regla_actual.bajarian} | ${a.regla_actual.mediana_sobre_costo ?? ''} % |`];
  for (const [m, s] of Object.entries(a.sensibilidad_margen)) l.push(`| Por margen: queda al menos ${m} % sobre costo | ${s.bajarian} | ${s.mediana_sobre_costo ?? ''} % |`);
  l.push('', '## Veredictos', '', '```json', JSON.stringify(a.veredictos, null, 1), '```', '', '## Quiénes son los rivales (los 30 que más nos ganan)', '',
    '| Vendedor | Id | Nos ganan en | Dif. mediana | Margen nuestro si igualamos | Viables | Venden bajo nuestro costo | Entrega inmediata / a demanda | Nivel | Ventas | Positivas | Desde | Lugar |', '|---|---|---:|---:|---:|---:|---:|---|---|---:|---:|---|---|');
  for (const v of a.vendedores.filter(x => x.id !== 'sin dato').slice(0, 30)) {
    const q = p[v.id] ?? {};
    l.push(`| ${v.nickname ?? q.nickname ?? ''} | ${v.id} | ${v.n} | $${v.mediana_dif_pesos} (${v.mediana_dif_pct} %) | ${v.mediana_sobre_costo_si_igualamos ?? ''} % | ${v.viables} (${v.pct_viables} %) | ${v.venden_bajo_nuestro_costo} | ${v.entrega_inmediata} / ${v.entrega_a_demanda} | ${q.nivel ?? ''} ${q.power_seller ?? ''} | ${q.ventas_completadas ?? ''} | ${q.calificacion_positiva != null ? Math.round(q.calificacion_positiva * 100) + ' %' : ''} | ${q.registro ?? ''} | ${q.ubicacion ?? q.pais ?? ''} |`);
  }
  const sd = a.vendedores.find(x => x.id === 'sin dato'); if (sd) l.push('', `Sin dato de vendedor: ${sd.n}.`);
  l.push('', '## Alcohol y Tabaco (referencia contra el cotizador de WhatsApp)', '',
    'Cotizador de Seba (Amado Libros): transferencia $3.010, tarjeta $3.420, envío incluido, 12 a 17 días, reserva 50 %. Equivalente en Mercado Libre (comisión 17 %): $3.627 con precio de transferencia, $4.120 con precio de tarjeta.', '');
  for (const f of o.alcohol_y_tabaco) l.push(`- ${f.id} ${f.titulo}: hoy ${f.precio}, ganador ${f.ganador_precio ?? 's/d'} (${f.ganador_vendedor ?? ''}, ${f.ganador_entrega ?? ''}), costo ${f.costo ?? 's/d'}, queda hoy ${f.queda_hoy ?? ''} (${f.sobre_costo_hoy ?? ''} %), objetivo ${f.objetivo ?? ''} queda ${f.queda_objetivo ?? ''}; veredicto: ${f.veredicto}.`);
  return l.join('\n') + '\n';
}
