// Resumen, tabla de detalle y correo diario (Resend, el que ya usa el proyecto).
import { CAMBIA } from './decision.mjs';
import { fechaMontevideo } from './config.mjs';

export function resumir(filas, { cuenta, real, inicio, ids, stats, umbral }) {
  const c = a => filas.filter(f => f.d.accion === a).length;
  const aplicada = a => filas.filter(f => f.d.accion === a && (real ? f.aplicado : true)).length;
  const contadores = {
    fecha: new Date().toISOString(), modo: real ? 'real' : 'dry_run',
    activas: ids, revisadas: filas.length,
    compiten: filas.filter(f => f.comp?.compite).length,
    marcadas: filas.filter(f => f.comp?.marcada).length,
    precio_dinamico: c('saltear_precio_dinamico'),
    ganador_inmediato: c('saltear_ganador_inmediato'),
    ganador_sin_dato: c('saltear_ganador_sin_dato'),
    bajadas: aplicada('bajar'),
    ajustadas: aplicada('ajustar'),
    subidas: aplicada('subir'),
    restauradas: aplicada('restaurar'),
    sin_tocar_umbral: c('sin_tocar_umbral'),
    sin_tocar_pct: c('sin_tocar_pct'),
    verificadas: filas.filter(f => f.verificado === true).length,
    no_verificadas: filas.filter(f => f.verificado === false).length,
    promo: c('saltear_promo') + c('saltear_promo_desconocida'),
    bajo_piso: filas.filter(f => f.d.accion === 'saltear_piso' && !/piso 1000000000000/.test(f.d.motivo)).length,
    sin_costo: filas.filter(f => f.d.accion === 'saltear_piso' && /piso 1000000000000/.test(f.d.motivo)).length,
    otras_salteadas: filas.filter(f => /^saltear_(moneda|variaciones|sin_precio)$/.test(f.d.accion)).length,
    editadas_a_mano: c('liberar_editada'),
    errores: c('error_consulta') + c('error_aplicar'),
    cambios_stock: filas.filter(f => Number.isFinite(f.d.stock) && (real ? f.aplicado : true)).length,
  };
  // Cómo está la cuenta en la competencia de catálogo, para contrastar con los
  // contadores del panel de ML (que suman sugerencias, no sólo las que pierden).
  const estados = {}, sugerencias = {}, motivos = {}, porTipo = {};
  for (const f of filas) if ((f.comp?.tipo === 'catalogo' || f.comp?.tipo === 'tradicional') && !f.comp.error) {
    estados[f.comp.estado || 'sin_estado'] = (estados[f.comp.estado || 'sin_estado'] ?? 0) + 1;
    for (const o of f.comp.oportunidades ?? []) sugerencias[o] = (sugerencias[o] ?? 0) + 1;
    for (const m of f.comp.motivos ?? []) { const k = `${f.comp.estado}:${typeof m === 'string' ? m : (m?.id ?? JSON.stringify(m))}`; motivos[k] = (motivos[k] ?? 0) + 1; }
    const k2 = `${f.comp.tipo}:${f.comp.estado}:${f.item.demanda ? 'a_demanda' : 'con_stock'}`; porTipo[k2] = (porTipo[k2] ?? 0) + 1;
  }
  const errores = {};
  for (const f of filas) if (/^error/.test(f.d.accion)) errores[f.d.motivo] = (errores[f.d.motivo] ?? 0) + 1;
  // Ejemplos de errores con el motivo que dio Mercado Libre (sin tokens ni datos personales).
  const ejemplosError = filas.filter(f => /^error/.test(f.d.accion)).slice(0, 10).map(f => ({ id: f.item.id, accion: f.d.accion, motivo: f.d.motivo ?? null, detalle: f.d.detalle ?? null }));
  // Por qué pierden las que compiten (precio, envío gratis, reputación o entrega).
  const contraDemanda = filas.filter(f => f.perdida?.contra_demanda).length;
  const causasPerdida = filas.filter(f => f.perdida).reduce((a, f) => (a[f.perdida.causa] = (a[f.perdida.causa] ?? 0) + 1, a), {});
  return { cuenta: cuenta.clave, umbral, causas_perdida: causasPerdida, pierden_contra_demanda: contraDemanda, ejemplos_error: ejemplosError, duracion_s: Math.round((Date.now() - inicio) / 1000), contadores, catalogo: { estados, publicaciones_con_alguna_sugerencia: filas.filter(f => f.comp?.oportunidades?.length).length, sugerencias, motivos, por_tipo: porTipo, errores_por_tipo: filas.filter(f => f.comp?.error).reduce((a, f) => (a[f.comp.error] = (a[f.comp.error] ?? 0) + 1, a), {}) }, errores, llamadas: stats.llamadas, por_status: stats.porStatus };
}

const ACCION = {
  bajar: 'Bajar al ganador', ajustar: 'Ajustar al ganador', subir: 'Subir (sigue ganando)', restaurar: 'Volver al original',
  sin_tocar_umbral: 'No tocar: diferencia por encima del tope', sin_tocar_pct: 'No tocar: bajaría más del 30 %', saltear_promo: 'Saltear: promoción activa',
  saltear_promo_desconocida: 'Saltear: no se pudo confirmar promoción', saltear_piso: 'Saltear: queda bajo el piso',
  saltear_variaciones: 'Saltear: tiene variaciones', saltear_moneda: 'Saltear: no está en pesos', saltear_sin_precio: 'Saltear: sin precio ganador',
  saltear_ganador_inmediato: 'No tocar: el ganador entrega de inmediato', saltear_ganador_sin_dato: 'No tocar: sin dato del plazo del ganador',
  saltear_precio_dinamico: 'No tocar: precio administrado por Mercado Libre', mantener: 'Mantener', mantener_promo: 'Mantener: promoción en curso', saltear_cambio_reciente: 'Saltear: el precio cambió durante la corrida', mantener_umbral: 'Mantener: el ganador bajó más de 360 desde el original', mantener_piso: 'Mantener: piso',
  liberar_editada: 'Liberar: editada a mano', error_consulta: 'Error de consulta', error_aplicar: 'Error al aplicar', inactiva: 'Inactiva',
};

export function tablaMarkdown(filas, { cuenta, real, resumen }) {
  const relevantes = filas.filter(f => f.comp?.marcada || f.comp?.compite || f.previo || /^error/.test(f.d.accion));
  const l = [`# Precio Ganador · ${cuenta.nombre} · ${real ? 'modo real' : 'DRY_RUN (no se cambió nada)'}`, '', '```json', JSON.stringify(resumen.contadores, null, 2), '```', '',
    '| Publicación | Tipo | Mi precio | Precio ganador | Diferencia | Qué haría | Stock | Motivo ML |', '|---|---|---:|---:|---:|---|---|---|'];
  for (const f of relevantes) {
    const g = f.comp?.ganador, p = f.item.price;
    const dif = Number.isFinite(g) && Number.isFinite(p) ? Math.round((p - g) * 100) / 100 : '';
    const stock = Number.isFinite(f.d.stock) ? `${f.item.available_quantity} → ${f.d.stock}` : (f.item.demanda ? `a demanda (${f.item.dias_demanda} d)` : '');
    const accion = (f.d.accion === 'saltear_piso' && /piso 1000000000000/.test(f.d.motivo) ? 'Saltear: sin costo conocido en la lista de SBS' : f.d.accion === 'saltear_piso' ? `Saltear: queda bajo el piso (${f.d.motivo.replace('piso ', '')})` : (ACCION[f.d.accion] ?? f.d.accion)) + (CAMBIA.has(f.d.accion) ? ` → ${f.d.precio}` : '') + (f.verificado === true ? ' (aplicado y verificado)' : f.verificado === false ? ` (NO verificado: ML muestra ${f.precio_leido})` : '');
    l.push(`| [${f.item.id}](${f.item.permalink ?? `https://articulo.mercadolibre.com.uy/${String(f.item.id).replace('MLU', 'MLU-')}`}) ${esc(f.item.title?.slice(0, 50) ?? '')} | ${f.comp?.tipo ?? ''} ${f.comp?.estado ?? ''} | ${p ?? ''} | ${g ?? ''} | ${dif} | ${accion} | ${stock} | ${(f.comp?.motivos ?? []).map(m => typeof m === 'string' ? m : (m?.id ?? '')).join(', ')} |`);
  }
  const conCausa = filas.filter(f => f.perdida);
  if (conCausa.length) {
    l.push('', '## Por qué pierden', '', `Nuestro nivel: ${conCausa.find(f => f.perdida.nuestro_nivel)?.perdida.nuestro_nivel ?? 'sin dato'}`, '', `Causas: ${Object.entries(resumen.causas_perdida ?? {}).map(([k, v]) => `${CAUSA[k] ?? k} ${v}`).join(' · ')}`, '',
      '| Publicación | Mi precio | Más barato de otro vendedor | Ganador | Nivel del ganador | Envío gratis nuestro | ML marca que nos falta | Causa | Días del ganador | Costo envío gratis | Palanca (todavía no se aplica) |', '|---|---:|---:|---:|---|---|---|---|---:|---:|---|');
    for (const f of conCausa) {
      const q = f.perdida;
      l.push(`| ${f.item.id} ${esc(f.item.title?.slice(0, 40) ?? '')} | ${f.item.price} | ${q.mas_barato ?? 'nadie'} | ${q.ganador_precio ?? ''} | ${q.ganador_nivel ?? ''} | ${q.envio_gratis_propio === true ? 'sí' : q.envio_gratis_propio === false ? 'no' : ''} | ${(q.le_falta ?? []).map(b => FALTA[b] ?? b).join(', ')} | ${CAUSA[q.causa] ?? q.causa} | ${q.ganador_dias ?? ''}${q.contra_demanda ? ' (a demanda)' : ''} | ${q.costo_envio_gratis ?? ''} | ${PALANCA[q.palanca] ?? q.palanca ?? ''} |`);
    }
  }
  const demanda = listaDemanda(filas);
  if (demanda.length) {
    l.push('', '## Pierden contra vendedores a demanda (más de 5 días): para publicar fuera de catálogo', '', '| Publicación | Mi precio | Precio del que gana | Días del que gana |', '|---|---:|---:|---:|');
    for (const x of demanda) l.push(`| ${x.id} ${esc(x.titulo.slice(0, 50))} | ${x.precio} | ${x.ganador ?? ''} | ${x.dias} |`);
  }
  if (Object.keys(resumen.errores).length) l.push('', '## Errores', '', ...Object.entries(resumen.errores).map(([k, v]) => `- ${k}: ${v}`));
  return l.join('\n') + '\n';
}
const esc = s => String(s).replace(/\|/g, '/');
const CAUSA = { precio: 'por precio', envio_gratis: 'por envío gratis', reputacion_entrega: 'por reputación o entrega', otro: 'otro', error: 'no se pudo leer', sin_ficha: 'sin ficha' };
const PALANCA = { bajar: 'bajar el precio', envio_gratis: 'poner envío gratis' };
const FALTA = { free_shipping: 'envío gratis', fulfillment: 'Full', same_day_shipping: 'envío en el día', free_installments: 'cuotas sin interés', shipping_collect: 'colecta' };

export async function enviarResumen({ cuenta, acum, resumen, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: 'sin_credenciales' };
  const to = (process.env.PRECIO_GANADOR_EMAIL_TO || 'undiaes@gmail.com').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>';
  const suma = k => acum.corridas.reduce((s, c) => s + (Number(c[k]) || 0), 0);
  const ult = acum.corridas.at(-1) ?? {};
  const filas = [
    ['Corridas del día', acum.corridas.length], ['Marcadas (última corrida)', ult.marcadas ?? 0],
    ['Bajadas al ganador', suma('bajadas')], ['Ajustadas al ganador', suma('ajustadas')],
    ['Subidas o vueltas al original', suma('subidas') + suma('restauradas')],
    ['Sin tocar por diferencia por encima del tope (última)', ult.sin_tocar_umbral ?? 0], ['Sin tocar por bajar más del 30 % (última)', ult.sin_tocar_pct ?? 0],
    ['Salteadas por promoción (última)', ult.promo ?? 0], ['Errores', suma('errores')], ['Cambios de stock', suma('cambios_stock')],
    ['Por qué pierden (última)', Object.entries(resumen.causas_perdida ?? {}).map(([k, v]) => `${CAUSA[k] ?? k}: ${v}`).join(' · ') || '—'],
  ];
  const est = resumen.catalogo?.estados ?? {};
  filas.push(['Catálogo: ganando', est.winning ?? 0], ['Catálogo: comparten el primer lugar', est.sharing_first_place ?? 0], ['Catálogo: perdiendo', est.competing ?? 0], ['Catálogo: con alguna sugerencia de ML (Full, cuotas, etc.)', resumen.catalogo?.publicaciones_con_alguna_sugerencia ?? 0]);
  const texto = filas.map(([k, v]) => `${k}: ${v}`).join('\n');
  const html = `<h2>Precio Ganador · ${cuenta.nombre} · ${fechaMontevideo()}</h2><p>Modo: ${ult.modo === 'real' ? 'real' : 'prueba (DRY_RUN, no se cambió nada)'}</p><table cellpadding="6" style="border-collapse:collapse">${filas.map(([k, v]) => `<tr><td>${k}</td><td style="text-align:right"><b>${v}</b></td></tr>`).join('')}</table><p>Si este correo no llega un día, algo se rompió: revisá el workflow Precio Ganador en GitHub.</p>`;
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `precio-ganador-${cuenta.clave}-${fechaMontevideo()}-${process.env.GITHUB_RUN_ID ?? Date.now()}` },
      body: JSON.stringify({ from, to, subject: `Precio Ganador ${cuenta.nombre}: ${suma('bajadas')} bajadas, ${suma('subidas') + suma('restauradas')} subidas, ${suma('errores')} errores`, html, text: texto }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok ? { status: 'enviado' } : { status: 'error', http: res.status };
  } catch { return { status: 'error_transporte' }; }
}

// Informe de la regla (sólo en prueba): qué haría la corrida, con rangos y ejemplos.
export function informeRegla(filas, { cuenta, maxCambios, reglas }) {
  const por = a => filas.filter(f => f.d.accion === a);
  const ej = (lista, extra = f => '') => lista.slice(0, 5).map(f => `- ${f.item.id} ${String(f.item.title ?? '').slice(0, 45).replace(/\|/g, '/')}: ${f.item.price}${f.comp?.ganador != null ? ` · ganador ${f.comp.ganador}` : ''}${f.d.precio != null ? ` · nuevo ${f.d.precio}` : ''}${extra(f)}`).join('\n') || '- ninguna';
  const rango = p => p < 1200 ? 'menos de 1.200' : p < 1500 ? '1.200 a 1.499' : p <= 1600 ? '1.500 a 1.600' : 'más de 1.600';
  const bajar = por('bajar'), ajustar = por('ajustar'), subir = por('subir'), restaurar = por('restaurar');
  const piso = por('saltear_piso'), inmediato = por('saltear_ganador_inmediato'), sinDato = por('saltear_ganador_sin_dato'), umbral = por('sin_tocar_umbral'), promo = filas.filter(f => /^saltear_promo/.test(f.d.accion));
  const cambios = bajar.length + ajustar.length + subir.length + restaurar.length;
  const rangos = {};
  for (const f of piso) rangos[rango(f.item.price)] = (rangos[rango(f.item.price)] ?? 0) + 1;
  const bajo1200 = filas.filter(f => f.comp?.compite && f.item.price < 1200);
  const enEstado = filas.filter(f => f.previo);
  const porEntrega = {};
  for (const f of enEstado) { const k = f.comp?.entrega_ganador ?? (f.comp?.compite ? 'sin consultar' : 'no compite'); porEntrega[k] = (porEntrega[k] ?? 0) + 1; }
  const l = [`# Informe de la regla · ${cuenta.nombre}`, '', `Regla: diferencia ${reglas.umbralInclusivo ? '<=' : '<'} ${reglas.umbral}, nuevo precio = ${Math.round((1 - (reglas.descuento || 0)) * 100)} % del ganador, piso ${cuenta.minimo ?? 'sin piso'}, ${cuenta.soloContraDemanda ? 'sólo contra ganadores a demanda' : 'contra cualquier ganador'}.`, '',
    '## Qué haría', '', '| Acción | Publicaciones |', '|---|---:|',
    `| Compiten sin ganar | ${filas.filter(f => f.comp?.compite).length} |`, `| Bajar | ${bajar.length} |`, `| Ajustar (ya bajadas, sigue al ganador) | ${ajustar.length} |`, `| Subir (ya bajadas, sigue ganando) | ${subir.length} |`, `| Volver al original | ${restaurar.length} |`,
    `| No tocar: diferencia por encima de ${reglas.umbral} | ${umbral.length} |`, `| No tocar: queda bajo el piso | ${piso.length} |`, `| No tocar: el ganador entrega de inmediato | ${inmediato.length} |`, `| No tocar: sin dato del plazo del ganador | ${sinDato.length} |`, `| Saltear: promoción | ${promo.length} |`,
    '', `**Cambios totales: ${cambios}** (freno: ${maxCambios}${cambios > maxCambios ? `; superado, propuesta maxCambios = ${Math.ceil(cambios * 1.2)}` : ''}).`, '',
    '## Bajo el piso, por precio actual', '', '| Precio actual | Publicaciones |', '|---|---:|', ...['menos de 1.200', '1.200 a 1.499', '1.500 a 1.600', 'más de 1.600'].map(k => `| ${k} | ${rangos[k] ?? 0} |`), '',
    `## Ya cuestan menos de 1.200 y compiten sin ganar: ${bajo1200.length} (no se tocan; Seba decide)`, '', ej(bajo1200), '',
    '## Ejemplos', '', '### Bajar', ej(bajar), '', '### Bajo el piso', ej(piso, f => ` · piso ${f.piso ?? ''}`), '', '### Ganador de entrega inmediata', ej(inmediato), '', '### Sin dato del plazo', ej(sinDato), '', '### Subir', ej(subir, f => ` · competidor a demanda en ${f.comp?.techo_de ?? '?'}`), '', '### Volver al original', ej(restaurar), '', '### Ajustar', ej(ajustar), '',
    `## Ya bajadas por el sistema (${enEstado.length}), según el ganador de hoy`, '', '| Ganador | Publicaciones |', '|---|---:|', ...Object.entries(porEntrega).map(([k, v]) => `| ${k} | ${v} |`), '',
    `De ellas, contra ganador de entrega inmediata: ${enEstado.filter(f => f.comp?.entrega_ganador === 'inmediato').length}; volverían al original ${enEstado.filter(f => f.comp?.entrega_ganador === 'inmediato' && f.d.accion === 'restaurar').length} y subirían ${enEstado.filter(f => f.comp?.entrega_ganador === 'inmediato' && f.d.accion === 'subir').length}.`];
  return l.join('\n') + '\n';
}

// Lista diaria para Gaby y Lola (adm@amadolibros.com.uy): publicaciones de catálogo que
// pierden contra un vendedor a demanda (más de 5 días). La idea es armar una publicación
// fuera de catálogo con entrega inmediata: el comprador apurado la elige aunque cueste más.
export function listaDemanda(filas) {
  return filas.filter(f => f.perdida?.contra_demanda).map(f => ({
    id: f.item.id, titulo: String(f.item.title ?? '').slice(0, 90), permalink: f.item.permalink ?? `https://articulo.mercadolibre.com.uy/${String(f.item.id).replace('MLU', 'MLU-')}`,
    precio: f.item.price, ganador: f.perdida.ganador_precio ?? f.comp?.ganador ?? null, dias: f.perdida.ganador_dias, competidores: f.perdida.competidores ?? null,
  })).sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0));
}

export async function enviarListaDemanda({ cuenta, lista, fetcher = (...a) => globalThis.fetch(...a) }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { status: 'sin_credenciales' };
  if (!lista.length) return { status: 'sin_casos' };
  const to = (process.env.LISTA_DEMANDA_EMAIL_TO || 'adm@amadolibros.com.uy,undiaes@gmail.com').split(',').map(s => s.trim()).filter(Boolean);
  const from = process.env.REPORT_EMAIL_FROM || 'Amado Libros <web@notificaciones.amadolibros.com>';
  const escH = v => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Una línea por libro, en el tono que pidió Seba (09/11/2026).
  const frase = x => x.ganador != null && x.ganador < x.precio
    ? `"${x.titulo}" queda oculta detrás de otra publicación de catálogo que está más barata ($ ${x.ganador}, la nuestra $ ${x.precio}) pero demora ${x.dias} días.`
    : `"${x.titulo}" queda oculta detrás de otra publicación de catálogo que demora ${x.dias} días (la nuestra $ ${x.precio}).`;
  const intro = 'Seba, estas publicaciones las tenemos para entrega inmediata, pero en la ficha de catálogo gana otro vendedor más barato que tarda días en entregar. Conviene armar una publicación fuera de catálogo que destaque la entrega inmediata.';
  const html = `<p>${escH(intro)}</p><ul style="font-family:sans-serif;font-size:14px">${lista.map(x => `<li style="margin-bottom:8px">${escH(frase(x))} <a href="${escH(x.permalink)}">Ver publicación</a></li>`).join('')}</ul>`;
  const texto = intro + '\n\n' + lista.map(x => `- ${frase(x)} ${x.permalink}`).join('\n');
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `lista-demanda-${cuenta.clave}-${fechaMontevideo()}` },
      body: JSON.stringify({ from, to, subject: `Seba, ${lista.length} ${lista.length === 1 ? 'libro queda oculto' : 'libros quedan ocultos'} detrás de vendedores que demoran días`, html, text: texto }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok ? { status: 'enviado', casos: lista.length } : { status: 'error', http: res.status };
  } catch { return { status: 'error_transporte' }; }
}
