// Reglas de negocio puras (sin red): alerta de catálogo, oportunidades de subida,
// casos para decidir. Reciben lo observado y devuelven casos con explicación.
// Ningún error de consulta se convierte acá en conclusión comercial.

const fechaCorta = iso => { const m = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? `${m[3]}/${m[2]}` : null; };
export const plazoTexto = o => {
  if (o.plazo_dias == null) return o.sin_envio ? 'sin opciones de envío al destino de referencia' : 'plazo no leído';
  const prep = o.plazo_dias === 0 ? 'sin plazo de preparación' : `${o.plazo_dias} días de preparación`;
  return o.llegada ? `${prep}; llegada estimada ${fechaCorta(o.llegada)} a ${o.destino ?? 'destino de referencia'}` : prep;
};
const fuentePlazo = o => o.plazo_fuente === 'shipping_options' ? `opciones de envío de ML (/items/{id}/shipping_options) hacia ${o.destino}` : o.plazo_fuente === 'items/bulk' ? 'sale_terms vía /items/bulk' : o.plazo_fuente === 'products/items' ? 'sale_terms vía /products/{id}/items' : 'no disponible';

// 4. Mi libro inmediato pierde la oferta destacada en catálogo.
export function alertasCatalogo(resultados) {
  const pierde = [], decidir = [];
  for (const r of resultados.values()) {
    const it = r.item;
    if (!it.catalogo || !r.ptw) continue;
    if (!r.ptw.ok) { decidir.push({ tipo: 'competencia_sin_estado', item: it, texto: `No se pudo leer el estado de competencia (${r.ptw.error}).` }); continue; }
    const d = r.ptw.data;
    if (d.status === 'winning' || !d.winner?.item_id || d.winner.item_id === it.id) continue;
    const ganador = (r.ofertas ?? []).find(o => o.item_id === d.winner.item_id) ?? { item_id: d.winner.item_id, precio: Number(d.winner.price), vendedor: '?', plazo_dias: null, plazo_fuente: null, enlace: `https://articulo.mercadolibre.com.uy/${String(d.winner.item_id).replace(/^MLU/, 'MLU-')}` };
    const precioGanador = Number.isFinite(ganador.precio) ? ganador.precio : Number(d.winner.price);
    const base = {
      item: it, ganador: { ...ganador, precio: precioGanador }, mi_precio: it.precio, diferencia: Math.round((precioGanador - it.precio) * 100) / 100,
      estado_ml: d.status, motivos_ml: Array.isArray(d.reason) ? d.reason : [], precio_para_ganar: Number.isFinite(Number(d.price_to_win)) ? Number(d.price_to_win) : null,
      boosts: (d.boosts ?? []).filter(b => b.status === 'opportunity').map(b => b.description), plazo_texto: plazoTexto(ganador), plazo_fuente: fuentePlazo(ganador), fecha: r.consulta.fecha,
    };
    if (precioGanador < it.precio && ganador.plazo_dias > 0) {
      pierde.push({ tipo: 'pierde_con_plazo', ...base, texto: `La oferta destacada es ${money(precioGanador)} (${money(it.precio - precioGanador)} menos) y declara ${ganador.plazo_dias} días de preparación. Amado lo entrega de inmediato: conviene decidir si se sostiene el precio y se destaca la entrega, o se ajusta.` });
    } else if (precioGanador < it.precio) {
      decidir.push({ tipo: 'pierde_sin_plazo', ...base, texto: `No somos la oferta destacada: el ganador está a ${money(precioGanador)} y ${ganador.plazo_dias === 0 ? 'según las opciones de envío de ML no tiene plazo de preparación' : 'no se pudo leer su plazo'}.` });
    } else {
      decidir.push({ tipo: 'pierde_por_otro_motivo', ...base, texto: `No somos la oferta destacada aunque el ganador no es más barato (${money(precioGanador)}). Motivo según Mercado Libre: ${base.motivos_ml.join(', ') || 'sin detalle'}${base.boosts.length ? `; mejoras posibles: ${base.boosts.join(', ')}` : ''}. Si no hay explicación suficiente, consultar a soporte.` });
    }
  }
  return { pierde, decidir };
}

// Control de cordura para sugerir importes (no son porcentajes de aumento).
export const REFERENCIA_MIN_VENDEDORES = 2;
export const REFERENCIA_MAX_RATIO = 2;

// 6. Oportunidades de subida: disponibilidad inmediata frente a nadie o frente a
// competidores con plazo. El sugerido sólo sale de una referencia observada.
export function oportunidades(resultados, { techos = {}, historial = {} } = {}) {
  const out = [];
  for (const r of resultados.values()) {
    const it = r.item;
    if (it.estado !== 'active' || it.disponible <= 0 || it.plazo_dias > 0) continue;
    if (!['sin_competidores', 'solo_con_plazo'].includes(r.estado)) continue;
    // Si en catálogo no ganamos, primero hay que resolver eso.
    if (it.catalogo && r.ptw?.ok && r.ptw.data.status !== 'winning') continue;
    const techo = Number.isFinite(Number(techos[it.id])) ? Number(techos[it.id]) : null;
    const h = historial[it.id] ?? null;
    const comps = r.comparables.map(o => ({ precio: o.precio, plazo_dias: o.plazo_dias, vendedor: o.vendedor, enlace: o.enlace, plazo_fuente: o.plazo_fuente, llegada: o.llegada ?? null, destino: o.destino ?? null, sin_envio: o.sin_envio }));
    let sugerido = null, motivo, referencia = null;
    if (r.estado === 'solo_con_plazo') {
      const masBarato = Math.min(...comps.map(c => c.precio));
      const vendedores = new Set(comps.map(c => c.vendedor)).size;
      referencia = { precio: masBarato, vendedores };
      motivo = `Todos los competidores de la ficha (${comps.length}) venden a pedido; Amado es el único con entrega inmediata.`;
      if (masBarato > it.precio) {
        // Una referencia sirve para sugerir si la respaldan dos vendedores o un
        // techo propio; muy lejos del precio actual (más del doble) se revisa a mano.
        const respaldada = techo != null || vendedores >= REFERENCIA_MIN_VENDEDORES;
        const lejana = masBarato > it.precio * REFERENCIA_MAX_RATIO && techo == null;
        if (respaldada && !lejana) { sugerido = techo != null ? Math.min(masBarato, techo) : masBarato; motivo += ` El competidor a pedido más barato cobra ${money(masBarato)}${vendedores > 1 ? ` (${vendedores} vendedores a pedido)` : ''}: referencia observada.`; }
        else motivo += ` El competidor a pedido más barato cobra ${money(masBarato)}, pero ${lejana ? 'está a más del doble de nuestro precio' : 'es un solo vendedor'}: oportunidad para revisar, sin importe sugerido.`;
      } else motivo += ` Nuestro precio ya está por encima del competidor a pedido más barato (${money(masBarato)}): oportunidad para revisar, sin importe sugerido.`;
    } else {
      motivo = `No se detectaron competidores en la ficha (consulta completa del ${r.consulta.fecha.slice(0, 10)}). Sin referencia de mercado: oportunidad para revisar.`;
    }
    if (sugerido != null && sugerido <= it.precio) sugerido = null;
    out.push({ item: it, estado: r.estado, precio_actual: it.precio, competidores: comps, techo, referencia, maximo_observado: h ? { precio: h.max_precio, fecha: h.max_fecha, desde: h.desde } : null, sugerido, motivo, fecha: r.consulta.fecha, revisar: sugerido == null });
  }
  return out.sort((a, b) => (b.sugerido ?? 0) - (a.sugerido ?? 0) || b.precio_actual - a.precio_actual);
}

// 5. Qué hacer con catálogo: recomendación por caso, con lo que falta comprobar.
export function recomendacionCatalogo(caso) {
  const it = caso.item;
  const pasos = [];
  if (caso.tipo === 'pierde_con_plazo') {
    pasos.push('Mantener la publicación de catálogo y revisar las condiciones que ML marca como mejorables' + (caso.boosts.length ? ` (${caso.boosts.join(', ')})` : '') + '.');
    pasos.push(caso.precio_para_ganar != null ? `Precio para ganar según ML: ${money(caso.precio_para_ganar)}. No es una orden de bajar: la entrega inmediata vale más que el plazo del ganador.` : 'ML no informó precio para ganar.');
  }
  if (it.relaciones.length) pasos.push(`La publicación tradicional vinculada (${it.relaciones.join(', ')}) sigue activa y comparte stock con la de catálogo. Falta comprobar en la web cuánta exposición le da Mercado Libre en los listados cuando perdemos la ficha: no se puede afirmar que desaparezca.`);
  else pasos.push('No se detectó una publicación tradicional vinculada (item_relations vacío).');
  pasos.push('Desvincular del catálogo: Libros (MLU-BOOKS) figura entre los dominios con catálogo obligatorio en Uruguay desde el 21/07/2023 (/catalog/dumps/domains/MLU/catalog_required). Salir del catálogo no es una opción disponible por API y no se recomienda; la vinculación la gestiona Mercado Libre.');
  pasos.push('Crear otra publicación tradicional no es solución: en un dominio con catálogo obligatorio Mercado Libre la asocia a la misma ficha y queda compitiendo en el mismo lugar, con riesgo de duplicado y sin historial de ventas.');
  if (caso.tipo === 'pierde_por_otro_motivo') pasos.push('Consultar a soporte de Mercado Libre con el id de la publicación y el estado devuelto por price_to_win: el ganador no es más barato y ML no da un motivo suficiente.');
  return pasos;
}

// Las publicaciones de catálogo y su tradicional gemela (item_relations, stock
// compartido) son el mismo libro para nosotros: una oportunidad por ficha, y si
// cualquiera de las nuestras pierde la oferta destacada, no hay oportunidad.
export function agruparPorFicha(ops, resultados) {
  const perdemos = new Set();
  for (const r of resultados.values()) if (r.pid && r.item.catalogo && r.ptw?.ok && r.ptw.data.status !== 'winning') perdemos.add(r.pid);
  const porFicha = new Map();
  for (const o of ops) {
    const pid = resultados.get(o.item.id)?.pid ?? null;
    if (pid && perdemos.has(pid)) continue;
    const key = pid ?? o.item.id;
    const prev = porFicha.get(key);
    if (!prev || (o.item.catalogo && !prev.item.catalogo)) porFicha.set(key, { ...o, gemelas: [...(prev ? [prev.item.id, ...(prev.gemelas ?? [])] : [])] });
    else prev.gemelas = [...(prev.gemelas ?? []), o.item.id];
  }
  return [...porFicha.values()];
}

export const money = v => v == null || !Number.isFinite(Number(v)) ? '—' : `$ ${Math.round(Number(v)).toLocaleString('es-UY')}`;
