// Reglas de negocio puras (sin red): alerta de catálogo, oportunidades de subida,
// casos para decidir. Reciben lo observado y devuelven casos con explicación.
// Ningún error de consulta se convierte acá en conclusión comercial.
import { SELLER_ID } from './config.mjs';

const fechaCorta = iso => { const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}` : null; };
export const plazoTexto = o => {
  if (o.sin_envio) return 'sin opciones de envío al destino de referencia';
  if (o.plazo_dias == null) return 'plazo no leído';
  const prep = o.plazo_dias === 0 ? 'sin plazo de preparación' : `${o.plazo_dias} días de preparación`;
  return o.llegada ? `${prep}; llegada estimada ${fechaCorta(o.llegada)} a ${o.destino ?? 'destino de referencia'}` : prep;
};
const fuentePlazo = o => o.plazo_fuente === 'shipping_options' ? `opciones de envío de ML hacia ${o.destino}` : o.plazo_fuente === 'products/items' ? 'condiciones de venta de la ficha' : 'no disponible';

// Motivos y mejoras de price_to_win en lenguaje comercial
// (developers.mercadolibre.com.ar/competencia-en-catalogo).
const MOTIVOS = {
  manufacturing_time: 'tiene plazo de preparación y el ganador tiene stock inmediato',
  temporarily_winning_manufacturing_time: 'gana con plazo de preparación sólo porque no hay otro inmediato de igual reputación',
  temporarily_competing_manufacturing_time: 'compite con plazo de preparación mientras no haya otro inmediato de igual reputación',
  winner_has_better_reputation: 'el ganador tiene mejor reputación',
  reputation_below_threshold: 'nuestra reputación está por debajo del mínimo para competir',
  shipping_mode: 'el modo de envío no permite competir',
  non_trusted_seller: 'Mercado Libre no considera confiable a la cuenta para esta ficha',
  newbie_program_seller: 'la cuenta está en el programa de vendedores nuevos',
  item_paused: 'la publicación está pausada',
};
const MEJORAS = { fulfillment: 'Full', free_installments: 'cuotas sin recargo', free_shipping: 'envío gratis', same_day_shipping: 'envío en el día', shipping_collect: 'colecta' };
const motivoTexto = r => MOTIVOS[r] ?? r;

// Inmediata comprobada de nuestro lado: con stock y sale_terms leídos sin plazo.
export const propiaInmediata = it => it.plazo_dias === 0 && it.disponible > 0;

const enlaceItem = id => `https://articulo.mercadolibre.com.uy/${String(id).replace(/^MLU/, 'MLU-')}`;

// 4. Estado de nuestras publicaciones de catálogo frente a la oferta destacada.
export function alertasCatalogo(resultados) {
  const pierde = [], decidir = [];
  const propios = new Set([...resultados.values()].map(r => r.item.id));
  for (const r of resultados.values()) {
    const it = r.item;
    if (!it.catalogo || !r.ptw) continue;
    if (!r.ptw.ok) { decidir.push({ tipo: 'competencia_sin_estado', item: it, texto: 'No se pudo leer el estado de competencia de esta publicación en la ficha. Se vuelve a intentar en la próxima corrida.' }); continue; }
    const d = r.ptw.data;
    const motivos = (Array.isArray(d.reason) ? d.reason : []).map(motivoTexto);
    if (d.status === 'winning') {
      if ((d.reason ?? []).some(x => String(x).startsWith('temporarily_'))) decidir.push({ tipo: 'gana_fragil', item: it, texto: `Somos la oferta destacada, pero según ML ${motivos.join('; ')}. La ventaja puede perderse si entra un competidor inmediato.` });
      continue;
    }
    if (d.status === 'sharing_first_place') {
      decidir.push({ tipo: 'comparte_primer_lugar', item: it, compartiendo: Number(d.competitors_sharing_first_place ?? 0), precio_para_ganar: num(d.price_to_win),
        texto: `Compartimos la oferta destacada con ${d.competitors_sharing_first_place ?? 'otros'} vendedor(es).${num(d.price_to_win) != null ? ` Para quedar solos, según ML: ${money(d.price_to_win)}.` : ''} No es perder la ficha.` });
      continue;
    }
    if (d.status === 'listed') {
      decidir.push({ tipo: 'no_compite', item: it, motivos_ml: motivos, texto: `La publicación aparece en la ficha pero no compite por la oferta destacada${motivos.length ? `: ${motivos.join('; ')}` : ''}. Es un motivo de nuestra cuenta o publicación, no de precio.` });
      continue;
    }
    if (!d.winner?.item_id || d.winner.item_id === it.id || propios.has(d.winner.item_id)) continue;
    const ganador = (r.ofertas ?? []).find(o => o.item_id === d.winner.item_id) ?? { item_id: d.winner.item_id, precio: Number(d.winner.price), vendedor: r.ficha?.ganador_vendedor ?? '?', plazo_dias: null, plazo_fuente: null, enlace: enlaceItem(d.winner.item_id) };
    if (ganador.vendedor === SELLER_ID) continue;
    const precioGanador = Number.isFinite(ganador.precio) ? ganador.precio : Number(d.winner.price);
    // Mejoras que el ganador tiene y nosotros podríamos tener.
    const nuestras = new Map((d.boosts ?? []).map(b => [b.id, b.status]));
    const delGanador = (d.winner.boosts ?? []).filter(b => b.status === 'boosted' && nuestras.get(b.id) === 'opportunity').map(b => MEJORAS[b.id] ?? b.description);
    const base = {
      item: it, ganador: { ...ganador, precio: precioGanador }, mi_precio: it.precio, diferencia: Math.round((precioGanador - it.precio) * 100) / 100,
      estado_ml: d.status, motivos_ml: motivos, precio_para_ganar: num(d.price_to_win), estrategia_ficha: r.ficha?.listing_strategy ?? null,
      boosts: (d.boosts ?? []).filter(b => b.status === 'opportunity').map(b => MEJORAS[b.id] ?? b.description), mejoras_del_ganador: delGanador,
      plazo_texto: plazoTexto(ganador), plazo_fuente: fuentePlazo(ganador), fecha: r.consulta.fecha,
    };
    if (ganador.plazo_dias > 0 && !propiaInmediata(it)) {
      decidir.push({ tipo: 'pierde_con_plazo_propio_no_inmediato', ...base, texto: `La oferta destacada declara ${ganador.plazo_dias} días de preparación, pero nuestra publicación ${it.plazo_dias > 0 ? `también declara ${it.plazo_dias} días de preparación` : it.disponible <= 0 ? 'no tiene stock publicado' : 'no permite confirmar que no tenga plazo'}: revisarla primero.` });
    } else if (ganador.plazo_dias > 0) {
      // Regla de ML: una oferta con plazo no le gana a una inmediata de igual
      // reputación. Si pasa, la causa no es el precio.
      pierde.push({ tipo: 'pierde_con_plazo', ...base, texto: `La oferta destacada ${precioGanador < it.precio ? `cobra ${money(precioGanador)} (${money(it.precio - precioGanador)} menos)` : `cobra ${money(precioGanador)}`} y declara ${ganador.plazo_dias} días de preparación; nosotros entregamos de inmediato. Según las reglas de catálogo de Mercado Libre, una oferta con plazo no le gana a una con stock inmediato de igual reputación: ${motivos.length ? `ML informa: ${motivos.join('; ')}.` : 'ML no informa motivo, así que conviene consultar a soporte.'} No es una orden de bajar el precio.` });
    } else if (precioGanador < it.precio) {
      decidir.push({ tipo: 'pierde_sin_plazo', ...base, texto: `No somos la oferta destacada: el ganador cobra ${money(precioGanador)} (nosotros ${money(it.precio)}) y ${ganador.plazo_dias === 0 ? 'según sus opciones de envío no tiene plazo de preparación' : 'no se pudo leer su plazo'}.${delGanador.length ? ` Además tiene ${delGanador.join(', ')} y nosotros no.` : ''}` });
    } else {
      decidir.push({ tipo: 'pierde_por_otro_motivo', ...base, texto: `No somos la oferta destacada aunque el ganador no es más barato (${money(precioGanador)}).${motivos.length ? ` Según ML: ${motivos.join('; ')}.` : ''}${delGanador.length ? ` El ganador tiene ${delGanador.join(', ')} y nosotros no.` : ''}${!motivos.length && !delGanador.length ? ' ML no da un motivo: consultar a soporte.' : ''}` });
    }
  }
  return { pierde, decidir };
}

// Un importe sugerido necesita respaldo: dos vendedores distintos o un techo propio.
export const REFERENCIA_MIN_VENDEDORES = 2;
const pct = (a, b) => Math.round((a / b - 1) * 100);

// 6. Oportunidades de subida: disponibilidad inmediata frente a nadie, frente a
// competidores con plazo, o frente a inmediatos que cobran más que nosotros.
export function oportunidades(resultados, { techos = {}, historial = {} } = {}) {
  const out = [];
  const yaArriba = [];
  for (const r of resultados.values()) {
    const it = r.item;
    if (it.estado !== 'active' || !propiaInmediata(it)) continue;
    // De catálogo: sólo si price_to_win confirma que ganamos. Un error no es "ganamos".
    if (it.catalogo && !(r.ptw?.ok && r.ptw.data.status === 'winning')) continue;
    const comps = r.comparables.map(o => ({ precio: o.precio, plazo_dias: o.plazo_dias, vendedor: o.vendedor, enlace: o.enlace, plazo_fuente: o.plazo_fuente, llegada: o.llegada ?? null, destino: o.destino ?? null, sin_envio: o.sin_envio, logistica: o.logistica }));
    const techo = Number.isFinite(Number(techos[it.id])) ? Number(techos[it.id]) : null;
    const h = historial[it.id] ?? null;
    let referencia = null, motivo;
    if (r.estado === 'solo_con_plazo') {
      const precios = comps.map(c => c.precio);
      const masBarato = Math.min(...precios);
      const vendedores = new Set(comps.filter(c => c.precio >= it.precio).map(c => c.vendedor)).size;
      if (masBarato <= it.precio) { yaArriba.push({ item: it, referencia: masBarato }); continue; }
      referencia = { precio: masBarato, vendedores, tipo: 'a_pedido' };
      motivo = `Todos los competidores de la ficha (${comps.length}) venden a pedido; Amado es el único con entrega inmediata. El más barato de ellos cobra ${money(masBarato)}, ${pct(masBarato, it.precio)}% más que nosotros.`;
    } else if (r.estado === 'con_sin_plazo_declarado') {
      // Hay inmediatos ajenos: sólo es oportunidad si todos cobran más que nosotros.
      const inmediatos = comps.filter(c => c.plazo_dias === 0 && !c.sin_envio);
      if (!inmediatos.length || inmediatos.some(c => c.precio <= it.precio)) continue;
      const masBarato = Math.min(...inmediatos.map(c => c.precio));
      referencia = { precio: masBarato, vendedores: new Set(inmediatos.map(c => c.vendedor)).size, tipo: 'inmediato' };
      motivo = `Hay ${inmediatos.length} competidor(es) con entrega inmediata y todos cobran más que nosotros; el más barato, ${money(masBarato)} (${pct(masBarato, it.precio)}% más).`;
    } else if (r.estado === 'sin_competidores') {
      motivo = `No hay otros vendedores en la ficha de catálogo (consulta completa del ${r.consulta.fecha.slice(0, 10)}). No se pudieron revisar publicaciones fuera de catálogo, así que no hay referencia de mercado: oportunidad para revisar.`;
    } else continue;
    let sugerido = null;
    if (referencia && (techo != null || referencia.vendedores >= REFERENCIA_MIN_VENDEDORES)) sugerido = techo != null ? Math.min(referencia.precio, techo) : referencia.precio;
    if (sugerido != null && sugerido <= it.precio) sugerido = null;
    if (referencia && sugerido == null) motivo += referencia.vendedores < REFERENCIA_MIN_VENDEDORES && techo == null ? ' La referencia es de un solo vendedor: para revisar, sin importe sugerido.' : ' Sin importe sugerido.';
    out.push({ item: it, estado: r.estado, precio_actual: it.precio, competidores: comps, techo, referencia, diferencia_pct: referencia ? pct(referencia.precio, it.precio) : null,
      maximo_observado: h ? { precio: h.max_precio, fecha: h.max_fecha, desde: h.desde } : null, sugerido, motivo, fecha: r.consulta.fecha, revisar: sugerido == null, ventas: it.vendidos });
  }
  // Primero los que tienen importe, por diferencia en pesos; después el resto.
  out.sort((a, b) => (b.sugerido != null) - (a.sugerido != null) || ((b.sugerido ?? b.referencia?.precio ?? b.precio_actual) - b.precio_actual) - ((a.sugerido ?? a.referencia?.precio ?? a.precio_actual) - a.precio_actual));
  out.yaArriba = yaArriba;
  return out;
}

// 5. Qué hacer con catálogo, para cada caso. Lo general (desvincular, crear otra
// publicación) va una sola vez en el reporte: ver PREGUNTAS_CATALOGO.
export function recomendacionCatalogo(caso) {
  const it = caso.item;
  const pasos = [];
  if (caso.tipo === 'pierde_con_plazo') {
    pasos.push(caso.motivos_ml?.length ? `Revisar lo que informa ML: ${caso.motivos_ml.join('; ')}.` : 'Consultar a soporte de Mercado Libre con el id de nuestra publicación, el id de la ficha y el estado de competencia: según sus reglas, una oferta con plazo no debería ganarle a una inmediata de igual reputación.');
    if (caso.precio_para_ganar != null) pasos.push(`Precio para ganar según ML: ${money(caso.precio_para_ganar)}. Es un dato, no una recomendación: la entrega inmediata vale más que el plazo del ganador.`);
  }
  if (caso.mejoras_del_ganador?.length) pasos.push(`El ganador tiene ${caso.mejoras_del_ganador.join(', ')} y nosotros no: evaluar si conviene activarlo (ML lo marca como mejora disponible para esta publicación).`);
  else if (caso.boosts?.length) pasos.push(`Mejoras que ML marca como disponibles para esta publicación: ${caso.boosts.join(', ')}.`);
  if (it.relaciones?.length) pasos.push(`La publicación tradicional vinculada (${it.relaciones.join(', ')}) sigue activa y se sincroniza con la de catálogo. Falta comprobar cuánta exposición tiene en los listados cuando perdemos la ficha: no se puede afirmar que desaparezca.`);
  if (caso.estrategia_ficha) pasos.push(caso.estrategia_ficha === 'catalog_required' ? 'Esta ficha tiene catálogo obligatorio (listing_strategy: catalog_required).' : `Estrategia de la ficha según ML: ${caso.estrategia_ficha}.`);
  return pasos;
}

export const PREGUNTAS_CATALOGO = [
  ['¿Podemos salir del catálogo?', 'Se puede pausar o cerrar la publicación de catálogo y la tradicional sigue activa (developers.mercadolibre.com.ar/en_us/catalog-listing). Pero en Libros, con catálogo obligatorio, Mercado Libre puede volver a asociarla (optin automático) o pedir el optin por moderación. No está comprobado para Uruguay y no se recomienda sin probarlo en un caso.'],
  ['¿Conviene crear otra publicación tradicional?', 'No como solución general. En fichas con catálogo obligatorio ML puede moderarla pidiendo el optin, hay riesgo de publicación duplicada y arranca sin historial. Ya existe una tradicional vinculada a cada publicación de catálogo.'],
  ['¿Qué sí está en nuestras manos?', 'Las condiciones que ML marca como mejorables en cada caso (Full, envío gratis, cuotas, envío en el día), el precio, y consultar a soporte cuando el resultado no tiene explicación.'],
];

// Las publicaciones de catálogo y su tradicional gemela (item_relations) son el
// mismo libro para nosotros: una oportunidad por ficha, y si cualquiera de las
// nuestras no gana la oferta destacada (o no se pudo saber), no hay oportunidad.
export function agruparPorFicha(ops, resultados) {
  const perdemos = new Set();
  for (const r of resultados.values()) if (r.pid && r.item.catalogo && !(r.ptw?.ok && r.ptw.data.status === 'winning')) perdemos.add(r.pid);
  const bloqueadas = new Set();
  for (const r of resultados.values()) if (r.item.catalogo && !(r.ptw?.ok && r.ptw.data.status === 'winning')) for (const rel of r.item.relaciones ?? []) bloqueadas.add(rel);
  const porFicha = new Map();
  for (const o of ops) {
    const pid = resultados.get(o.item.id)?.pid ?? null;
    if ((pid && perdemos.has(pid)) || bloqueadas.has(o.item.id)) continue;
    const key = pid ?? o.item.id;
    const prev = porFicha.get(key);
    if (!prev || (o.item.catalogo && !prev.item.catalogo)) porFicha.set(key, { ...o, gemelas: [...(prev ? [prev.item.id, ...(prev.gemelas ?? [])] : [])] });
    else prev.gemelas = [...(prev.gemelas ?? []), o.item.id];
  }
  const res = [...porFicha.values()];
  res.yaArriba = ops.yaArriba ?? [];
  return res;
}

// Gemelas con condiciones distintas: ML sincroniza precio, entrega y stock entre
// catálogo y tradicional, pero pueden desincronizarse.
export function gemelasDesincronizadas(items) {
  const porId = new Map(items.map(i => [i.id, i]));
  const out = [], vistos = new Set();
  for (const it of items) for (const rel of it.relaciones ?? []) {
    const otra = porId.get(rel);
    const clave = [it.id, rel].sort().join('|');
    if (!otra || vistos.has(clave)) continue;
    vistos.add(clave);
    if (Number.isFinite(it.precio) && Number.isFinite(otra.precio) && it.precio !== otra.precio) out.push({ item: it.catalogo ? it : otra, tipo: 'gemela_precio_distinto', texto: `La publicación de catálogo y su tradicional vinculada tienen precios distintos (${money(it.precio)} y ${money(otra.precio)}, ${it.id} / ${otra.id}). Revisar la sincronización.` });
    else if ((it.plazo_dias ?? 0) !== (otra.plazo_dias ?? 0)) out.push({ item: it.catalogo ? it : otra, tipo: 'gemela_plazo_distinto', texto: `La publicación de catálogo y su tradicional vinculada declaran plazos distintos (${it.id} / ${otra.id}).` });
  }
  return out;
}

const num = v => Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null;
export const money = v => v == null || !Number.isFinite(Number(v)) ? '—' : `$ ${Math.round(Number(v)).toLocaleString('es-UY')}`;
