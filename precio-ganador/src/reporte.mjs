// Resumen, tabla de detalle y correo diario (Resend, el que ya usa el proyecto).
import { CAMBIA } from './decision.mjs';
import { fechaMontevideo } from './config.mjs';

export function resumir(filas, { cuenta, real, inicio, ids, stats, umbral }) {
  const c = a => filas.filter(f => f.d.accion === a).length;
  const aplicada = a => filas.filter(f => f.d.accion === a && (real ? f.aplicado : true)).length;
  const contadores = {
    fecha: new Date().toISOString(), modo: real ? 'real' : 'dry_run',
    activas: ids, revisadas: filas.length,
    marcadas: filas.filter(f => f.comp?.marcada).length,
    bajadas: aplicada('bajar'),
    ajustadas: aplicada('ajustar'),
    subidas: aplicada('subir'),
    restauradas: aplicada('restaurar'),
    sin_tocar_umbral: c('sin_tocar_umbral'),
    sin_tocar_pct: c('sin_tocar_pct'),
    verificadas: filas.filter(f => f.verificado === true).length,
    no_verificadas: filas.filter(f => f.verificado === false).length,
    promo: c('saltear_promo') + c('saltear_promo_desconocida'),
    otras_salteadas: filas.filter(f => /^saltear_(moneda|variaciones|piso|sin_precio)$/.test(f.d.accion)).length,
    editadas_a_mano: c('liberar_editada'),
    errores: c('error_consulta') + c('error_aplicar'),
    cambios_stock: filas.filter(f => Number.isFinite(f.d.stock) && (real ? f.aplicado : true)).length,
  };
  // Cómo está la cuenta en la competencia de catálogo, para contrastar con los
  // contadores del panel de ML (que suman sugerencias, no sólo las que pierden).
  const estados = {}, sugerencias = {};
  for (const f of filas) if (f.comp?.tipo === 'catalogo' && !f.comp.error) {
    estados[f.comp.estado || 'sin_estado'] = (estados[f.comp.estado || 'sin_estado'] ?? 0) + 1;
    for (const o of f.comp.oportunidades ?? []) sugerencias[o] = (sugerencias[o] ?? 0) + 1;
  }
  const errores = {};
  for (const f of filas) if (/^error/.test(f.d.accion)) errores[f.d.motivo] = (errores[f.d.motivo] ?? 0) + 1;
  return { cuenta: cuenta.clave, umbral, duracion_s: Math.round((Date.now() - inicio) / 1000), contadores, catalogo: { estados, publicaciones_con_alguna_sugerencia: filas.filter(f => f.comp?.oportunidades?.length).length, sugerencias }, errores, llamadas: stats.llamadas, por_status: stats.porStatus };
}

const ACCION = {
  bajar: 'Bajar al ganador', ajustar: 'Ajustar al ganador', subir: 'Subir (sigue ganando)', restaurar: 'Volver al original',
  sin_tocar_umbral: 'No tocar: diferencia de 360 o más', sin_tocar_pct: 'No tocar: bajaría más del 30 %', saltear_promo: 'Saltear: promoción activa',
  saltear_promo_desconocida: 'Saltear: no se pudo confirmar promoción', saltear_piso: 'Saltear: queda bajo el piso',
  saltear_variaciones: 'Saltear: tiene variaciones', saltear_moneda: 'Saltear: no está en pesos', saltear_sin_precio: 'Saltear: sin precio ganador',
  mantener: 'Mantener', mantener_umbral: 'Mantener: el ganador bajó más de 360 desde el original', mantener_piso: 'Mantener: piso',
  liberar_editada: 'Liberar: editada a mano', error_consulta: 'Error de consulta', error_aplicar: 'Error al aplicar', inactiva: 'Inactiva',
};

export function tablaMarkdown(filas, { cuenta, real, resumen }) {
  const relevantes = filas.filter(f => f.comp?.marcada || f.previo || /^error/.test(f.d.accion));
  const l = [`# Precio Ganador · ${cuenta.nombre} · ${real ? 'modo real' : 'DRY_RUN (no se cambió nada)'}`, '', '```json', JSON.stringify(resumen.contadores, null, 2), '```', '',
    '| Publicación | Tipo | Mi precio | Precio ganador | Diferencia | Qué haría | Stock |', '|---|---|---:|---:|---:|---|---|'];
  for (const f of relevantes) {
    const g = f.comp?.ganador, p = f.item.price;
    const dif = Number.isFinite(g) && Number.isFinite(p) ? Math.round((p - g) * 100) / 100 : '';
    const stock = Number.isFinite(f.d.stock) ? `${f.item.available_quantity} → ${f.d.stock}` : (f.item.demanda ? `a demanda (${f.item.dias_demanda} d)` : '');
    const accion = (ACCION[f.d.accion] ?? f.d.accion) + (CAMBIA.has(f.d.accion) ? ` → ${f.d.precio}` : '') + (f.verificado === true ? ' (aplicado y verificado)' : f.verificado === false ? ` (NO verificado: ML muestra ${f.precio_leido})` : '');
    l.push(`| [${f.item.id}](${f.item.permalink ?? `https://articulo.mercadolibre.com.uy/${String(f.item.id).replace('MLU', 'MLU-')}`}) ${esc(f.item.title?.slice(0, 50) ?? '')} | ${f.comp?.tipo ?? ''} ${f.comp?.estado ?? ''} | ${p ?? ''} | ${g ?? ''} | ${dif} | ${accion} | ${stock} |`);
  }
  if (Object.keys(resumen.errores).length) l.push('', '## Errores', '', ...Object.entries(resumen.errores).map(([k, v]) => `- ${k}: ${v}`));
  return l.join('\n') + '\n';
}
const esc = s => String(s).replace(/\|/g, '/');

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
    ['Sin tocar por diferencia de 360 o más (última)', ult.sin_tocar_umbral ?? 0], ['Sin tocar por bajar más del 30 % (última)', ult.sin_tocar_pct ?? 0],
    ['Salteadas por promoción (última)', ult.promo ?? 0], ['Errores', suma('errores')], ['Cambios de stock', suma('cambios_stock')],
  ];
  const est = resumen.catalogo?.estados ?? {};
  filas.push(['Catálogo: ganando', est.winning ?? 0], ['Catálogo: comparten el primer lugar', est.sharing_first_place ?? 0], ['Catálogo: perdiendo', est.competing ?? 0], ['Catálogo: con alguna sugerencia de ML (Full, cuotas, etc.)', resumen.catalogo?.publicaciones_con_alguna_sugerencia ?? 0]);
  const texto = filas.map(([k, v]) => `${k}: ${v}`).join('\n');
  const html = `<h2>Precio Ganador · ${cuenta.nombre} · ${fechaMontevideo()}</h2><p>Modo: ${ult.modo === 'real' ? 'real' : 'prueba (DRY_RUN, no se cambió nada)'}</p><table cellpadding="6" style="border-collapse:collapse">${filas.map(([k, v]) => `<tr><td>${k}</td><td style="text-align:right"><b>${v}</b></td></tr>`).join('')}</table><p>Si este correo no llega un día, algo se rompió: revisá el workflow Precio Ganador en GitHub.</p>`;
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `precio-ganador-${cuenta.clave}-${fechaMontevideo()}` },
      body: JSON.stringify({ from, to, subject: `Precio Ganador ${cuenta.nombre}: ${suma('bajadas')} bajadas, ${suma('subidas') + suma('restauradas')} subidas, ${suma('errores')} errores`, html, text: texto }),
      signal: AbortSignal.timeout(30000),
    });
    return res.ok ? { status: 'enviado' } : { status: 'error', http: res.status };
  } catch { return { status: 'error_transporte' }; }
}
