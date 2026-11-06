// Reporte HTML en lenguaje comercial: casos con enlaces y una explicación corta.
// compacto: versión para el cuerpo del correo (primeros casos de cada sección);
// el reporte completo va adjunto.
import { money, recomendacionCatalogo, plazoTexto, PREGUNTAS_CATALOGO } from './analisis.mjs';
import { montevideoNow } from './config.mjs';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const fecha = iso => { try { return montevideoNow(new Date(iso)); } catch { return iso; } };
const vendedor = o => o.vendedor && o.vendedor !== '?' ? `vendedor ${o.vendedor}` : 'competidor';
const full = o => o.logistica === 'fulfillment' ? ' · Full' : '';
const ESTADOS = { competing: 'compite sin ganar', listed: 'aparece sin competir', sharing_first_place: 'comparte el primer lugar', winning: 'gana' };

function seccion(titulo, intro, cuerpo, n, { extra = '' } = {}) {
  return `<section><h2>${esc(titulo)} <span class="n">${n}</span></h2><p class="intro">${esc(intro)}</p>${cuerpo || '<p class="vacio">Nada para mostrar en esta corrida.</p>'}${extra}</section>`;
}

function casoPierde(c, marca) {
  const it = c.item;
  return `<article class="caso alerta">
    <h3>${marca}${link(it.enlace, it.titulo)}</h3>
    <table class="kv">
      <tr><th>Mi precio</th><td>${money(c.mi_precio)} (entrega inmediata, ${it.disponible} en stock)</td></tr>
      <tr><th>Oferta destacada</th><td>${link(c.ganador.enlace, c.ganador.item_id)} · ${esc(vendedor(c.ganador))} · ${money(c.ganador.precio)}${full(c.ganador)}</td></tr>
      <tr><th>Diferencia</th><td>${money(Math.abs(c.diferencia))} ${c.diferencia < 0 ? 'más barato que nosotros' : c.diferencia > 0 ? 'más caro que nosotros' : '(mismo precio)'}</td></tr>
      <tr><th>Plazo del competidor</th><td>${esc(c.plazo_texto)} <small>(fuente: ${esc(c.plazo_fuente)}. La preparación es del vendedor; la llegada es una estimación de ML para ese destino y cambia según dónde esté el comprador)</small></td></tr>
      <tr><th>Estado en ML</th><td>${esc(ESTADOS[c.estado_ml] ?? c.estado_ml)}${c.motivos_ml.length ? ` · ${esc(c.motivos_ml.join('; '))}` : ''}${c.precio_para_ganar != null ? ` · precio para ganar según ML: ${money(c.precio_para_ganar)}` : ''}</td></tr>
      <tr><th>Observado</th><td>${esc(fecha(c.fecha))}</td></tr>
    </table>
    <p>${esc(c.texto)}</p>
    <details open><summary>Qué hacer</summary><ol>${recomendacionCatalogo(c).map(p => `<li>${esc(p)}</li>`).join('')}</ol></details>
  </article>`;
}

function casoOportunidad(o, marca) {
  const it = o.item;
  const comps = o.competidores.length ? `<ul>${o.competidores.slice(0, 6).map(c => `<li>${link(c.enlace, vendedor(c))}: ${money(c.precio)}${full(c)} · ${esc(plazoTexto(c))}</li>`).join('')}${o.competidores.length > 6 ? `<li>… y ${o.competidores.length - 6} más</li>` : ''}</ul>` : 'Sin otros vendedores en la ficha de catálogo.';
  return `<article class="caso ${o.revisar ? 'revisar' : 'oportunidad'}">
    <h3>${marca}${link(it.enlace, it.titulo)}</h3>
    <table class="kv">
      <tr><th>Precio actual</th><td>${money(o.precio_actual)} · ${it.disponible} en stock${o.ventas ? ` · ${o.ventas} vendidos en la publicación` : ''}</td></tr>
      <tr><th>Competidores</th><td>${comps}</td></tr>
      <tr><th>Referencia observada</th><td>${o.referencia ? `${money(o.referencia.precio)} (${o.referencia.tipo === 'inmediato' ? 'competidor inmediato más barato' : 'competidor a pedido más barato'}; ${o.referencia.vendedores} vendedor${o.referencia.vendedores > 1 ? 'es' : ''}) · ${o.diferencia_pct}% sobre nuestro precio` : 'sin referencia de mercado'}</td></tr>
      <tr><th>Techo comercial</th><td>${o.techo != null ? money(o.techo) : 'no definido'}</td></tr>
      <tr><th>Máximo observado</th><td>${o.maximo_observado ? `${money(o.maximo_observado.precio)} el ${esc(o.maximo_observado.fecha)} <small>(dato histórico desde ${esc(o.maximo_observado.desde)}; no es un techo ni un precio recomendado)</small>` : 'seguimiento recién iniciado'}</td></tr>
      <tr><th>Precio sugerido</th><td>${o.sugerido != null ? `<strong>${money(o.sugerido)}</strong>` : '<strong>Oportunidad para revisar</strong>'}</td></tr>
    </table>
    <p>${esc(o.motivo)}${o.gemelas?.length ? ` <small>Incluye la publicación vinculada ${esc(o.gemelas.join(', '))}.</small>` : ''}</p>
  </article>`;
}

const fila = (c, marca = '') => `<li>${marca}${link(c.item.enlace, c.item.titulo)} — ${esc(c.texto)}${c.ganador ? ` Destacada: ${link(c.ganador.enlace, c.ganador.item_id)} a ${money(c.ganador.precio)}.` : ''}</li>`;

export function renderReporte({ resumen, pierde, oportunidades, errores, decidir, incompletas, metricas, novedades = [], capPlazos = { estado: 'ok' }, compacto = false, soloNovedades = false }) {
  const nov = new Set(novedades.map(n => n.item.id + '|' + n.tipo));
  const esNuevo = (id, tipo) => nov.has(id + '|' + tipo);
  const marca = (id, tipo) => esNuevo(id, tipo) ? '<span class="nuevo">nuevo</span> ' : '';
  const filtra = (lista, tipoDe) => soloNovedades ? lista.filter(c => esNuevo(c.item.id, tipoDe(c))) : lista;
  const LIM = compacto ? 15 : Infinity;

  const pierdeV = filtra(pierde, c => c.tipo);
  const decidirV = filtra(decidir, c => c.tipo);
  const opsV = filtra(oportunidades, () => 'oportunidad');
  const errV = filtra(errores, c => c.tipo);
  const conImporte = opsV.filter(o => o.sugerido != null), aRevisar = opsV.filter(o => o.sugerido == null);
  const avisoPlazos = capPlazos.estado === 'ok' ? '' : `<p class="caso revisar"><strong>Plazos de los competidores sin verificar.</strong> La consulta de opciones de envío falló (${capPlazos.fallidas ?? 0} de ${capPlazos.consultadas ?? 0}). Los casos con competidores quedan como "información insuficiente": no se cuentan como inmediatos ni como a pedido.</p>`;
  const masLink = (n, total) => total > n ? `<p class="mas">… y ${total - n} más en el reporte completo adjunto.</p>` : '';

  const opsCuerpo = conImporte.slice(0, LIM).map(o => casoOportunidad(o, marca(o.item.id, 'oportunidad'))).join('')
    + (compacto ? masLink(Math.min(LIM, conImporte.length), conImporte.length) + (aRevisar.length ? `<p class="mas">${aRevisar.length} oportunidades más para revisar, sin importe sugerido, en el reporte adjunto.</p>` : '')
      : (aRevisar.length ? `<details><summary>${aRevisar.length} oportunidades para revisar, sin importe sugerido</summary>${aRevisar.map(o => casoOportunidad(o, marca(o.item.id, 'oportunidad'))).join('')}</details>` : ''));

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Precios Amado</title>
<style>
body{font:15px/1.45 system-ui,Segoe UI,Roboto,sans-serif;margin:0 auto;padding:16px;background:#f7f5f0;color:#222;max-width:960px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px;border-bottom:2px solid #d9d2c5;padding-bottom:4px}h3{font-size:16px;margin:0 0 8px}
.n{background:#444;color:#fff;border-radius:10px;padding:0 8px;font-size:13px;vertical-align:middle}
.intro{color:#555;margin:0 0 10px}.vacio,.mas{color:#777;font-style:italic}
.caso{background:#fff;border-left:5px solid #999;border-radius:6px;padding:12px 14px;margin:10px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.alerta{border-color:#c0392b}.oportunidad{border-color:#1e8449}.revisar{border-color:#d68910}
.kv{border-collapse:collapse;width:100%;font-size:14px}.kv th{text-align:left;color:#666;font-weight:600;width:170px;padding:3px 8px 3px 0;vertical-align:top}.kv td{padding:3px 0}
.kv ul{margin:0;padding-left:18px}small{color:#777}.nuevo{background:#d68910;color:#fff;font-size:11px;border-radius:4px;padding:1px 5px;vertical-align:middle}
.resumen{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.resumen div{background:#fff;border-radius:6px;padding:8px 12px;min-width:120px;flex:1 1 140px}.resumen b{display:block;font-size:20px}
summary{cursor:pointer;font-weight:600;margin:8px 0}.metricas{font-size:13px;color:#666;margin-top:30px}a{color:#1a5276}dt{font-weight:600;margin-top:8px}dd{margin:2px 0 0 0;color:#444}
</style></head><body>
<h1>Precios Amado${soloNovedades ? ' — novedades' : ''}</h1>
<p class="intro">Corrida del ${esc(metricas.fecha_montevideo)} · ${resumen.analizadas} publicaciones activas analizadas${resumen.total_activas > resumen.analizadas ? ` de ${resumen.total_activas}` : ''} · ${resumen.catalogo} en catálogo. Nada de esto cambia precios ni publicaciones.</p>
<div class="resumen">
  <div><b>${pierde.length}</b>pierden la ficha frente a un competidor con plazo</div>
  <div><b>${oportunidades.filter(o => o.sugerido != null).length}</b>subas con referencia</div>
  <div><b>${oportunidades.filter(o => o.sugerido == null).length}</b>oportunidades para revisar</div>
  <div><b>${decidir.length}</b>casos de catálogo para decidir</div>
  <div><b>${errores.length}</b>posibles errores de configuración</div>
  <div><b>${incompletas.length}</b>consultas incompletas</div>
</div>
${avisoPlazos}
${seccion('Perdemos la oferta destacada frente a un competidor con plazo', 'Tenemos el libro para entrega inmediata, pero la ficha destaca a un vendedor que declara días de preparación. Según las reglas de Mercado Libre esto no debería pasar con igual reputación: el aviso es para revisar el motivo, no una orden de bajar el precio.', pierdeV.slice(0, LIM).map(c => casoPierde(c, marca(c.item.id, c.tipo))).join('') + (compacto ? masLink(LIM, pierdeV.length) : ''), pierdeV.length)}
${seccion('Oportunidades de subida', `Libros donde la entrega inmediata puede justificar un mejor precio. Primero los que tienen una referencia observada y respaldada; después, los que conviene mirar. ${resumen.ya_arriba ? `Además hay ${resumen.ya_arriba} libros donde ya cobramos más que todos los vendedores a pedido: no se listan.` : ''}`, opsCuerpo, opsV.length)}
${seccion('Casos de catálogo para decidir', 'Situaciones en la ficha que no son una pérdida frente a un competidor con plazo: compartir el primer lugar, no competir por un motivo de la cuenta, o perder sin una explicación de precio.', decidirV.length ? `<ul>${decidirV.slice(0, compacto ? 20 : Infinity).map(c => fila(c, marca(c.item.id, c.tipo))).join('')}</ul>${compacto ? masLink(20, decidirV.length) : ''}` : '', decidirV.length,
  { extra: compacto ? '' : `<details><summary>Preguntas frecuentes de catálogo</summary><dl>${PREGUNTAS_CATALOGO.map(([q, a]) => `<dt>${esc(q)}</dt><dd>${esc(a)}</dd>`).join('')}</dl></details>` })}
${seccion('Posibles errores de configuración', 'Condiciones de nuestras publicaciones que conviene revisar.', errV.length ? `<ul>${errV.slice(0, compacto ? 20 : Infinity).map(c => fila(c, marca(c.item.id, c.tipo))).join('')}</ul>${compacto ? masLink(20, errV.length) : ''}` : '', errV.length)}
${compacto ? `<p class="mas">${incompletas.length} consultas incompletas o fallidas: el detalle está en el reporte adjunto. No significan que no haya competencia.</p>` : seccion('Consultas incompletas o fallidas', 'Publicaciones donde no se pudo comprobar la competencia. No significa que no haya competencia.', incompletas.length ? `<details><summary>Ver ${incompletas.length}</summary><ul>${incompletas.map(c => `<li>${link(c.item.enlace, c.item.titulo)} — ${esc(c.motivo)}</li>`).join('')}</ul></details>` : '', incompletas.length)}
<p class="metricas">Duración ${Math.round((metricas.duracion_ms ?? 0) / 1000)} s · ${metricas.llamadas} llamadas a la API (${metricas.reintentos} reintentos, ${metricas.errores} errores) · plazos de competidores desde opciones de envío hacia ${esc(capPlazos.destino ?? 'Montevideo')} · fuente: API oficial de Mercado Libre, token ${metricas.token === 'worker' ? 'de la cuenta (Worker)' : 'de aplicación'} · sin IA ni scraping.</p>
</body></html>`;
}
