#!/usr/bin/env node
// Recorrido completo: conexión → publicaciones → competencia → alertas de
// catálogo → oportunidades → reporte HTML → correo (si hay credenciales).
//
//   node precios-amado/src/run.mjs [--limit N] [--sin-correo] [--solo-catalogo]
//
// En la salida estándar sólo van conteos y métricas: los logs de GitHub Actions
// de un repo público son públicos, y acá hay precios de terceros.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, SELLER_ID, REPORT_DIR, montevideoDate, montevideoNow } from './config.mjs';
import { createMlClient } from './ml-client.mjs';
import { pickTokenSource } from './token.mjs';
import { listActiveIds, fetchItems, configIssues } from './publicaciones.mjs';
import { analizarCompetencia } from './competencia.mjs';
import { alertasCatalogo, oportunidades, agruparPorFicha } from './analisis.mjs';
import { renderReporte } from './reporte.mjs';
import { enviarCorreo } from './correo.mjs';
import * as store from './store.mjs';
import { clasificarAvisos, decidirEnvio } from './avisos.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const limit = Number(opt('--limit', Infinity)) || Infinity;
const sinCorreo = args.includes('--sin-correo');
const soloCatalogo = args.includes('--solo-catalogo');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  if (!store.acquireLock()) { log('Hay otra corrida en curso (lock). Salgo.'); process.exit(3); }
  const started = Date.now();
  const ahora = new Date().toISOString(), hoy = montevideoDate();
  const metricas = { inicio: ahora, fecha_montevideo: montevideoNow(), limit: Number.isFinite(limit) ? limit : null };
  try {
    // 1. Conexión
    const source = pickTokenSource();
    const ml = createMlClient(source);
    const me = await ml.get('/users/me');
    if (String(me?.id) !== SELLER_ID) throw new Error(`El token corresponde al usuario ${me?.id}, no a ${SELLER_ID}`);
    log(`Conectado como ${me.nickname} (${me.id}); token: ${source.name}`);
    metricas.token = source.name;

    // 2. Publicaciones
    const { ids, total } = await listActiveIds(ml, { limit });
    log(`Publicaciones activas: ${total}; a analizar: ${ids.length}`);
    const { items: todas, fallidos } = await fetchItems(ml, ids);
    const items = soloCatalogo ? todas.filter(i => i.catalogo) : todas;
    const errores = configIssues(items);
    log(`Detalle leído: ${items.length} (${fallidos.length} fallidas); en catálogo: ${items.filter(i => i.catalogo).length}; con ISBN: ${items.filter(i => i.isbn).length}; errores de configuración: ${errores.length}`);

    // 3. Competencia
    let last = 0;
    const resultados = await analizarCompetencia(ml, items, { onProgress: (d, n) => { if (d - last >= 500 || d === n) { last = d; log(`Fichas consultadas: ${d}/${n}`); } } });
    const porEstado = {};
    for (const r of resultados.values()) porEstado[r.estado] = (porEstado[r.estado] ?? 0) + 1;
    log('Competencia por estado:', JSON.stringify(porEstado));
    const capPlazos = resultados.capacidadPlazos ?? { estado: 'ok' };
    log('Plazos de terceros (shipping_options):', JSON.stringify(capPlazos));
    metricas.plazos_terceros = capPlazos; metricas.por_estado = porEstado;

    // 4–6. Alertas, decisiones, oportunidades
    const historial = store.updateHistorial(items, hoy);
    const { pierde, decidir } = alertasCatalogo(resultados);
    const config = loadConfig();
    const ops = agruparPorFicha(oportunidades(resultados, { techos: config.techos, historial }), resultados);
    const incompletas = [...resultados.values()].filter(r => r.estado === 'insuficiente' || r.estado === 'plazo_no_verificado').map(r => ({ item: r.item, motivo: r.estado === 'plazo_no_verificado' ? `hay ${r.comparables.length} competidor(es) en la ficha, pero su plazo de preparación no se pudo verificar` : r.consulta?.error ? `error ${r.consulta.error} en ${r.consulta.fuente}` : !r.item.isbn && !r.pid ? 'sin ISBN ni ficha de catálogo: no hay forma permitida de buscar competencia' : !r.pid ? 'no se encontró una ficha de catálogo con ese ISBN (la búsqueda general de ML está cerrada para la cuenta)' : r.consulta?.completa === false ? 'consulta incompleta' : 'plazo de los competidores no legible' }));
    for (const f of fallidos) incompletas.push({ item: { id: f.id, titulo: f.id, enlace: `https://articulo.mercadolibre.com.uy/${String(f.id).replace(/^MLU/, 'MLU-')}` }, motivo: `no se pudo leer la publicación (${f.motivo})` });
    log(`Pierden en catálogo con plazo: ${pierde.length}; oportunidades: ${ops.length} (${ops.filter(o => o.sugerido != null).length} con importe); para decidir: ${decidir.length}; incompletas: ${incompletas.length}`);

    // Avisos sin repetir
    const casos = [...pierde, ...decidir, ...ops.map(o => ({ ...o, tipo: 'oportunidad' })), ...errores];
    const avisosPrevios = store.loadAvisos();
    const { novedades, avisos } = clasificarAvisos(casos, avisosPrevios.huellas ?? {}, ahora);
    const envio = decidirEnvio({ fechaMontevideo: hoy, ultimoResumen: avisosPrevios.ultimo_resumen ?? null, novedades });
    log(`Novedades: ${novedades.length}; correo: ${envio.motivo}`);

    // 8. Reporte
    Object.assign(metricas, { duracion_ms: Date.now() - started, llamadas: ml.stats.calls, reintentos: ml.stats.retries, errores: ml.stats.errors, por_status: ml.stats.byStatus, publicaciones: items.length, fichas: new Set([...resultados.values()].map(r => r.pid).filter(Boolean)).size });
    const html = renderReporte({ resumen: { analizadas: items.length, total_activas: total, catalogo: items.filter(i => i.catalogo).length }, pierde, oportunidades: ops, errores, decidir, incompletas, metricas, novedades, capPlazos });
    mkdirSync(REPORT_DIR, { recursive: true });
    const nombre = `precios-amado-${ahora.replace(/[:.]/g, '-').slice(0, 19)}.html`;
    writeFileSync(join(REPORT_DIR, nombre), html);
    writeFileSync(join(REPORT_DIR, 'ultimo.html'), html);
    log(`Reporte: ${join(REPORT_DIR, nombre)}`);

    // Foto compacta de la corrida (sin títulos: ids, precios y estados).
    store.saveObservacion(ahora.replace(/[:.]/g, '-').slice(0, 19), {
      fecha: ahora, items: [...resultados.values()].map(r => ({ id: r.item.id, pid: r.pid, precio: r.item.precio, estado: r.estado, ptw: r.ptw?.data?.status ?? null, ganador: r.ptw?.data?.winner?.item_id ?? null, ganador_precio: r.ptw?.data?.winner?.price ?? null, comparables: r.comparables?.map(c => [c.item_id, c.precio, c.plazo_dias]) ?? [] })),
    });

    // Correo
    let correo = { status: 'omitido' };
    if (!sinCorreo && envio.enviar) {
      const asunto = envio.motivo === 'resumen_diario' ? `Precios Amado — resumen ${hoy}: ${pierde.length} pierden con plazo, ${ops.length} oportunidades` : `Precios Amado — ${novedades.length} novedades`;
      correo = await enviarCorreo({ asunto, html, texto: `Reporte Precios Amado ${hoy}. Pierden con plazo: ${pierde.length}. Oportunidades: ${ops.length}. Para decidir: ${decidir.length}. Errores de configuración: ${errores.length}. Incompletas: ${incompletas.length}.` });
      log(`Correo: ${correo.status}${correo.detalle ? ' ' + correo.detalle : ''}`);
    }
    // Sólo se da por avisado lo que se mandó. Sin correo (prueba), o si el envío
    // falló, el estado de avisos no se toca: la próxima corrida los vuelve a mandar.
    if (!sinCorreo && (correo.status === 'enviado' || !envio.enviar)) {
      store.saveAvisos({ huellas: avisos, ultimo_resumen: envio.motivo === 'resumen_diario' ? hoy : avisosPrevios.ultimo_resumen ?? null });
    }
    metricas.correo = correo.status;
    store.appendCorrida(metricas);
    log('Métricas:', JSON.stringify(metricas));
  } finally { store.releaseLock(); }
}

main().catch(e => { console.error('Falló la corrida:', e.message); store.releaseLock(); process.exit(1); });
