// Reglas de negocio puras (sin red): alerta de catálogo, oportunidades de subida,
// casos para decidir. Reciben lo observado y devuelven casos con explicación.
// Ningún error de consulta se convierte acá en conclusión comercial.

const plazoTexto = o => o.plazo_dias == null ? 'plazo no leído' : o.plazo_dias === 0 ? 'sin plazo declarado' : `${o.plazo_dias} días de preparación declarados`;
const fuentePlazo = o => o.plazo_fuente === 'items/bulk' ? 'sale_terms vía /items/bulk' : o.plazo_fuente === 'products/items' ? 'sale_terms vía /products/{id}/items' : 'no disponible';

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
      decidir.push({ tipo: 'pierde_sin_plazo', ...base, texto: `No somos la oferta destacada: el ganador está a ${money(precioGanador)} y ${ganador.plazo_dias === 0 ? 'no declara plazo (no está comprobado que entregue de inmediato)' : 'no se pudo leer su plazo'}.` });
    } else {
      decidir.push({ tipo: 'pierde_por_otro_motivo', ...base, texto: `No somos la oferta destacada aunque el ganador no es más barato (${money(precioGanador)}). Motivo según Mercado Libre: ${base.motivos_ml.join(', ') || 'sin detalle'}${base.boosts.length ? `; mejoras posibles: ${base.boosts.join(', ')}` : ''}. Si no hay explicación suficiente, consultar a soporte.` });
    }
  }
  return { pierde, decidir };
}

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
    const comps = r.comparables.map(o => ({ precio: o.precio, plazo_dias: o.plazo_dias, vendedor: o.vendedor, enlace: o.enlace, plazo_fuente: o.plazo_fuente }));
    let sugerido = null, motivo;
    if (r.estado === 'solo_con_plazo') {
      const masBarato = Math.min(...comps.map(c => c.precio));
      motivo = `Todos los competidores de la ficha (${comps.length}) venden a pedido; Amado es el único con entrega inmediata.`;
      if (masBarato > it.precio) { sugerido = techo != null ? Math.min(masBarato, techo) : masBarato; motivo += ` El competidor a pedido más barato cobra ${money(masBarato)}: referencia observada para igualar.`; }
      else motivo += ` Nuestro precio ya está por encima del competidor a pedido más barato (${money(masBarato)}): oportunidad para revisar, sin importe sugerido.`;
    } else {
      motivo = `No se detectaron competidores en la ficha (consulta completa del ${r.consulta.fecha.slice(0, 10)}). Sin referencia de mercado: oportunidad para revisar.`;
    }
    if (sugerido != null && sugerido <= it.precio) sugerido = null;
    out.push({ item: it, estado: r.estado, precio_actual: it.precio, competidores: comps, techo, maximo_observado: h ? { precio: h.max_precio, fecha: h.max_fecha, desde: h.desde } : null, sugerido, motivo, fecha: r.consulta.fecha, revisar: sugerido == null });
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
  if (it.relaciones.length) pasos.push(`Existe publicación relacionada (${it.relaciones.join(', ')}): verificar si es tradicional y si muestra la entrega inmediata.`);
  else pasos.push('No se detectó una publicación tradicional vinculada en la API (item_relations vacío): no se recomienda crear otra sin comprobar que el dominio MLU-BOOKS en Uruguay lo permita y las reglas de duplicados.');
  pasos.push('Desvincular del catálogo no es una acción del vendedor por API para una publicación de catálogo: Mercado Libre decide la vinculación. Falta comprobar en el panel de ML si ofrece "dejar de participar en catálogo" para este producto.');
  if (caso.tipo === 'pierde_por_otro_motivo') pasos.push('Consultar a soporte de Mercado Libre con el id de la publicación y el estado devuelto por price_to_win.');
  return pasos;
}

export const money = v => v == null || !Number.isFinite(Number(v)) ? '—' : `$ ${Math.round(Number(v)).toLocaleString('es-UY')}`;
