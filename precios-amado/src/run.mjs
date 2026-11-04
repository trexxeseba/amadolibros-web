#!/usr/bin/env node
// Recorrido completo: conexión → publicaciones → competencia → alertas de
// catálogo → oportunidades → reporte HTML → correo (si hay credenciales).
//
//   node precios-amado/src/run.mjs [--limit N] [--sin-correo] [--solo-catalogo]
//
// Con --limit, --sin-correo o --solo-catalogo la corrida es de PRUEBA: genera el
// reporte pero no guarda historial ni avisos, para no ensuciar el seguimiento.
//
// En la salida estándar sólo van conteos y métricas: los logs de GitHub Actions
// de un repo público son públicos, y acá hay precios de terceros.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, SELLER_ID, REPORT_DIR, montevideoDate, montevideoNow } from './config.mjs';
import { createMlClient } from './ml-client.mjs';
import { pickTokenSource } from './token.mjs';
import { listActiveIds, fetchItems, configIssues } from './publicaciones.mjs';
import { analizarCompetencia } from './competencia.mjs';
import { alertasCatalogo, oportunidades, agruparPorFicha, gemelasDesincronizadas } from './analisis.mjs';
import { renderReporte } from './reporte.mjs';
import { enviarCorreo } from './correo.mjs';
import * as store from './store.mjs';
import { clasificarAvisos, decidirEnvio } from './avisos.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const limit = Number(opt('--limit', Infinity)) || Infinity;
const sinCorreo = args.includes('--sin-correo');
const soloCatalogo = args.includes('--solo-catalogo');
const prueba = sinCorreo || soloCatalogo || Number.isFinite(limit);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const enlace = id => `https://articulo.mercadolibre.com.uy/${String(id).replace(/^MLU/, 'MLU-')}`;

async function main() {
  if (!store.lock()) { log('Hay otra corrida en curso (lock). Salgo.'); process.exitCode = 3; return; }
  const started = Date.now();
  const ahora = new Date().toISOString(), hoy = montevideoDate();
  const metricas = { inicio: ahora, fecha_montevideo: montevideoNow(), limit: Number.isFinite(limit) ? limit : null, prueba };
  try {
    // 1. Conexión
    const source = pickTokenSource();
    const ml = createMlClient(source);
    const me = await ml.get('/users/me');
    if (String(me?.id) !== SELLER_ID) throw new Error(`El token corresponde al usuario ${me?.id}, no a ${SELLER_ID}`);
    log(`Conectado como ${me.nickname} (${me.id}); token: ${source.name}${prueba ? ' · corrida de prueba' : ''}`);
    metricas.token = source.name;

    // 2. Publicaciones
    const { ids, total } = await listActiveIds(ml, { limit });
    const parcial = !Number.isFinite(limit) && ids.length < total;
    log(`Publicaciones activas: ${total}; a analizar: ${ids.length}${parcial ? ' (LISTADO INCOMPLETO)' : ''}`);
    const { items: todas, fallidos } = await fetchItems(ml, ids);
    const items = soloCatalogo ? todas.filter(i => i.catalogo) : todas;
    const errores = [...configIssues(items), ...gemelasDesincronizadas(items)];
    // Publicaciones que ML marcó para moderación de catálogo (tag catalog_forewarning).
    try {
      const fw = await ml.get(`/users/${SELLER_ID}/items/search?status=active&tags=catalog_forewarning&limit=100`);
      const marcadas = new Set(Array.isArray(fw?.results) ? fw.results : []);
      for (const it of items) if (marcadas.has(it.id)) errores.push({ item: it, tipo: 'catalog_forewarning', texto: 'Mercado Libre la marcó con aviso de catálogo (catalog_forewarning): puede moderarla si no se asocia a la ficha.' });
      metricas.catalog_forewarning = marcadas.size;
    } catch (e) { metricas.catalog_forewarning = `error ${e.code}`; }
    log(`Detalle leído: ${items.length} (${fallidos.length} fallidas); en catálogo: ${items.filter(i => i.catalogo).length}; con ISBN: ${items.filter(i => i.isbn).length}; errores de configuración: ${errores.length}`);

    // 3. Competencia
    let last = 0;
    const resultados = await analizarCompetencia(ml, items, { onProgress: (d, n) => { if (d - last >= 500 || d === n) { last = d; log(`Fichas consultadas: ${d}/${n}`); } } });
    if (ml.stats.tokenFatal) throw new Error(`Token de Mercado Libre no disponible (${ml.stats.tokenFatal}): no se genera reporte para no mostrar datos incompletos como si fueran reales.`);
    const porEstado = {};
    for (const r of resultados.values()) porEstado[r.estado] = (porEstado[r.estado] ?? 0) + 1;
    log('Competencia por estado:', JSON.stringify(porEstado));
    const capPlazos = resultados.capacidadPlazos ?? { estado: 'ok' };
    log('Plazos de terceros (shipping_options):', JSON.stringify(capPlazos));
    const ptwEstados = {};
    for (const r of resultados.values()) if (r.ptw) { const k = r.ptw.ok ? r.ptw.data.status : `error_${r.ptw.error}`; ptwEstados[k] = (ptwEstados[k] ?? 0) + 1; }
    log('Estado en la ficha (price_to_win):', JSON.stringify(ptwEstados));
    metricas.plazos_terceros = capPlazos; metricas.por_estado = porEstado; metricas.price_to_win = ptwEstados;

    // 4–6. Alertas, decisiones, oportunidades
    const historial = store.updateHistorial(items, hoy, { guardar: !prueba && !parcial });
    const { pierde, decidir } = alertasCatalogo(resultados);
    const config = loadConfig();
    const ops = agruparPorFicha(oportunidades(resultados, { techos: config.techos, historial }), resultados);
    const incompletas = [...resultados.values()].filter(r => r.estado === 'insuficiente' || r.estado === 'plazo_no_verificado').map(r => ({ item: r.item, motivo: r.estado === 'plazo_no_verificado' ? `hay ${r.comparables.length} competidor(es) en la ficha, pero su plazo de preparación o su condición no se pudo verificar` : r.consulta?.error ? `error ${r.consulta.error} en ${r.consulta.fuente}` : !r.item.isbn && !r.pid ? 'sin ISBN ni ficha de catálogo: no hay forma permitida de buscar competencia' : !r.pid ? 'no se encontró una ficha de catálogo con ese ISBN (la búsqueda general de ML está cerrada para la cuenta)' : r.consulta?.completa === false ? 'consulta incompleta' : 'plazo de los competidores no legible' }));
    for (const f of fallidos) incompletas.push({ item: { id: f.id, titulo: f.id, enlace: enlace(f.id) }, motivo: `no se pudo leer la publicación (${f.motivo})` });
    if (parcial) incompletas.unshift({ item: { id: '—', titulo: 'Listado de publicaciones', enlace: 'https://www.mercadolibre.com.uy/' }, motivo: `Mercado Libre devolvió ${ids.length} de ${total} publicaciones activas: el análisis no cubre todo el catálogo.` });
    log(`Pierden en catálogo con plazo: ${pierde.length}; oportunidades: ${ops.length} (${ops.filter(o => o.sugerido != null).length} con importe; ${ops.yaArriba.length} ya cobran más que los a pedido); para decidir: ${decidir.length}; incompletas: ${incompletas.length}`);

    // Avisos sin repetir
    const casos = [...pierde, ...decidir, ...ops.map(o => ({ ...o, tipo: 'oportunidad' })), ...errores];
    const avisosPrevios = store.loadAvisos();
    const { novedades, avisos } = clasificarAvisos(casos, avisosPrevios.huellas ?? {}, ahora);
    const envio = parcial ? { enviar: false, motivo: 'listado_incompleto' } : decidirEnvio({ fechaMontevideo: hoy, ultimoResumen: avisosPrevios.ultimo_resumen ?? null, novedades });
    log(`Novedades: ${novedades.length}; correo: ${envio.motivo}`);

    // 8. Reporte
    Object.assign(metricas, { duracion_ms: Date.now() - started, llamadas: ml.stats.calls, reintentos: ml.stats.retries, errores: ml.stats.errors, por_status: ml.stats.byStatus, publicaciones: items.length, fichas: new Set([...resultados.values()].map(r => r.pid).filter(Boolean)).size, ya_arriba: ops.yaArriba.length });
    const datos = { resumen: { analizadas: items.length, total_activas: total, catalogo: items.filter(i => i.catalogo).length, ya_arriba: ops.yaArriba.length }, pierde, oportunidades: ops, errores, decidir, incompletas, metricas, novedades, capPlazos };
    const html = renderReporte(datos);
    mkdirSync(REPORT_DIR, { recursive: true });
    const sello = ahora.replace(/[:.]/g, '-').slice(0, 19);
    writeFileSync(join(REPORT_DIR, `precios-amado-${sello}.html`), html);
    writeFileSync(join(REPORT_DIR, 'ultimo.html'), html);
    log(`Reporte: ${join(REPORT_DIR, `precios-amado-${sello}.html`)}`);

    // Foto compacta de la corrida (sin títulos: ids, precios y estados).
    if (!prueba) store.saveObservacion(sello, {
      fecha: ahora, items: [...resultados.values()].map(r => ({ id: r.item.id, pid: r.pid, precio: r.item.precio, estado: r.estado, ptw: r.ptw?.data?.status ?? null, ganador: r.ptw?.data?.winner?.item_id ?? null, ganador_precio: r.ptw?.data?.winner?.price ?? null, comparables: r.comparables?.map(c => [c.item_id, c.precio, c.plazo_dias]) ?? [] })),
    });

    // Correo: cuerpo corto (Gmail corta los correos de más de ~100 KB) y el reporte completo adjunto.
    let correo = { status: 'omitido' };
    if (!sinCorreo && envio.enviar) {
      const asunto = envio.motivo === 'resumen_diario'
        ? `Precios Amado ${hoy}: ${ops.filter(o => o.sugerido != null).length} subas con referencia, ${pierde.length + decidir.length} casos de catálogo`
        : `Precios Amado: ${novedades.length} novedad${novedades.length === 1 ? '' : 'es'}`;
      const cuerpo = renderReporte({ ...datos, compacto: true, soloNovedades: envio.motivo === 'novedades' });
      const idem = 'precios-' + createHash('sha256').update(`${hoy}|${envio.motivo}|${novedades.map(n => n.item.id + n.tipo).sort().join(',')}`).digest('hex').slice(0, 32);
      correo = await enviarCorreo({ asunto, html: cuerpo, adjunto: { nombre: `precios-amado-${hoy}.html`, contenido: html }, idempotencia: idem,
        texto: `Precios Amado ${hoy}. Oportunidades: ${ops.length} (${ops.filter(o => o.sugerido != null).length} con importe). Catálogo: ${pierde.length} pierden frente a un competidor con plazo, ${decidir.length} para decidir. Errores de configuración: ${errores.length}. Consultas incompletas: ${incompletas.length}. Reporte completo adjunto.` });
      log(`Correo: ${correo.status}${correo.detalle ? ' ' + correo.detalle : ''}`);
    }
    // Sólo se da por avisado lo que se mandó. En prueba, si el envío falló o el
    // listado vino incompleto, el estado de avisos no se toca.
    if (!prueba && !parcial && (correo.status === 'enviado' || !envio.enviar)) {
      store.saveAvisos({ huellas: avisos, ultimo_resumen: envio.motivo === 'resumen_diario' ? hoy : avisosPrevios.ultimo_resumen ?? null });
    }
    metricas.correo = correo.status;
    if (!prueba) store.appendCorrida(metricas);
    log('Métricas:', JSON.stringify(metricas));
  } finally { store.releaseLock(); }
}

main().catch(e => { console.error('Falló la corrida:', e.message); store.releaseLock(); process.exitCode = 1; });
