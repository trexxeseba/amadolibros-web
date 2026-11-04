// Reporte HTML en lenguaje comercial: casos con enlaces y una explicación corta.
import { money, recomendacionCatalogo, plazoTexto } from './analisis.mjs';
import { montevideoNow } from './config.mjs';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const link = (href, text) => `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
const fecha = iso => { try { return montevideoNow(new Date(iso)); } catch { return iso; } };
const vendedor = o => o.vendedor && o.vendedor !== '?' ? `vendedor ${o.vendedor}` : 'competidor';

function seccion(titulo, intro, cuerpo, n) {
  return `<section><h2>${esc(titulo)} <span class="n">${n}</span></h2><p class="intro">${esc(intro)}</p>${cuerpo || '<p class="vacio">Nada para mostrar en esta corrida.</p>'}</section>`;
}

function casoPierde(c) {
  const it = c.item;
  return `<article class="caso alerta">
    <h3>${link(it.enlace, it.titulo)}</h3>
    <table class="kv">
      <tr><th>Mi precio</th><td>${money(c.mi_precio)} (entrega inmediata, ${it.disponible} en stock)</td></tr>
      <tr><th>Oferta destacada</th><td>${link(c.ganador.enlace, c.ganador.item_id)} · ${esc(vendedor(c.ganador))} · ${money(c.ganador.precio)}</td></tr>
      <tr><th>Diferencia</th><td>${money(Math.abs(c.diferencia))} ${c.diferencia < 0 ? 'más barato que nosotros' : 'más caro que nosotros'}</td></tr>
      <tr><th>Plazo del competidor</th><td>${esc(c.plazo_texto)} <small>(fuente: ${esc(c.plazo_fuente)}. La preparación es del vendedor; la llegada es una estimación de ML para ese destino y cambia según dónde esté el comprador)</small></td></tr>
      <tr><th>Estado en ML</th><td>${esc(c.estado_ml)}${c.motivos_ml.length ? ` · motivos: ${esc(c.motivos_ml.join(', '))}` : ''}${c.precio_para_ganar != null ? ` · precio para ganar: ${money(c.precio_para_ganar)}` : ''}</td></tr>
      <tr><th>Observado</th><td>${esc(fecha(c.fecha))}</td></tr>
    </table>
    <p>${esc(c.texto)}</p>
    <details><summary>Qué hacer con catálogo</summary><ol>${recomendacionCatalogo(c).map(p => `<li>${esc(p)}</li>`).join('')}</ol></details>
  </article>`;
}

function casoOportunidad(o) {
  const it = o.item;
  const comps = o.competidores.length ? `<ul>${o.competidores.map(c => `<li>${link(c.enlace, vendedor(c))}: ${money(c.precio)} · ${esc(plazoTexto(c))}</li>`).join('')}</ul>` : '<p>Sin competidores en la ficha.</p>';
  return `<article class="caso ${o.revisar ? 'revisar' : 'oportunidad'}">
    <h3>${link(it.enlace, it.titulo)}</h3>
    <table class="kv">
      <tr><th>Precio actual</th><td>${money(o.precio_actual)}</td></tr>
      <tr><th>Competidores</th><td>${comps}</td></tr>
      <tr><th>Referencia observada</th><td>${o.referencia ? `${money(o.referencia.precio)} (competidor a pedido más barato; ${o.referencia.vendedores} vendedor${o.referencia.vendedores > 1 ? 'es' : ''} a pedido)` : 'sin referencia de mercado'}</td></tr>
      <tr><th>Techo comercial</th><td>${o.techo != null ? money(o.techo) : 'no definido (se carga en config.json → techos)'}</td></tr>
      <tr><th>Máximo observado</th><td>${o.maximo_observado ? `${money(o.maximo_observado.precio)} el ${esc(o.maximo_observado.fecha)} <small>(dato histórico desde ${esc(o.maximo_observado.desde)}; no es un techo ni un precio recomendado)</small>` : 'seguimiento recién iniciado'}</td></tr>
      <tr><th>Precio sugerido</th><td>${o.sugerido != null ? `<strong>${money(o.sugerido)}</strong>` : '<strong>Oportunidad para revisar</strong> (sin referencia suficiente para un importe)'}</td></tr>
    </table>
    <p>${esc(o.motivo)}</p>
  </article>`;
}

const filaSimple = (c, extra = '') => `<li>${link(c.item.enlace, c.item.titulo)} — ${esc(c.texto ?? extra)}</li>`;

export function renderReporte({ resumen, pierde, oportunidades, errores, decidir, incompletas, metricas, novedades = [], capPlazos = { estado: 'ok' } }) {
  const avisoPlazos = capPlazos.estado === 'ok' ? '' : `<p class="caso revisar"><strong>Plazos de los competidores sin verificar.</strong> La consulta de opciones de envío falló (${capPlazos.fallidas ?? 0} de ${capPlazos.consultadas ?? 0}). Los casos con competidores quedan como "información insuficiente": no se cuentan como inmediatos ni como a pedido.</p>`;
  const nov = new Set(novedades.map(n => n.item.id + '|' + n.tipo));
  const marca = c => nov.has(c.item.id + '|' + c.tipo) ? '<span class="nuevo">nuevo</span> ' : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Precios Amado</title>
<style>
body{font:15px/1.45 system-ui,Segoe UI,Roboto,sans-serif;margin:0;padding:16px;background:#f7f5f0;color:#222;max-width:960px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 6px;border-bottom:2px solid #d9d2c5;padding-bottom:4px}h3{font-size:16px;margin:0 0 8px}
.n{background:#444;color:#fff;border-radius:10px;padding:0 8px;font-size:13px;vertical-align:middle}
.intro{color:#555;margin:0 0 10px}.vacio{color:#777;font-style:italic}
.caso{background:#fff;border-left:5px solid #999;border-radius:6px;padding:12px 14px;margin:10px 0;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.alerta{border-color:#c0392b}.oportunidad{border-color:#1e8449}.revisar{border-color:#d68910}
.kv{border-collapse:collapse;width:100%;font-size:14px}.kv th{text-align:left;color:#666;font-weight:600;width:170px;padding:3px 8px 3px 0;vertical-align:top}.kv td{padding:3px 0}
.kv ul{margin:0;padding-left:18px}small{color:#777}.nuevo{background:#d68910;color:#fff;font-size:11px;border-radius:4px;padding:1px 5px;vertical-align:middle}
.resumen{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}.resumen div{background:#fff;border-radius:6px;padding:8px 12px;min-width:120px}.resumen b{display:block;font-size:20px}
.metricas{font-size:13px;color:#666;margin-top:30px}a{color:#1a5276}
</style></head><body>
<h1>Precios Amado</h1>
<p class="intro">Corrida del ${esc(metricas.fecha_montevideo)} · ${resumen.analizadas} publicaciones activas analizadas${resumen.total_activas > resumen.analizadas ? ` de ${resumen.total_activas}` : ''} · ${resumen.catalogo} en catálogo.</p>
<div class="resumen">
  <div><b>${pierde.length}</b>pierden en catálogo frente a un competidor con plazo</div>
  <div><b>${oportunidades.length}</b>oportunidades de subida</div>
  <div><b>${errores.length}</b>posibles errores de configuración</div>
  <div><b>${decidir.length}</b>casos para decidir</div>
  <div><b>${incompletas.length}</b>consultas incompletas</div>
</div>
${avisoPlazos}
${seccion('Amado pierde la oferta destacada frente a un competidor con plazo', 'Tenemos el libro para entrega inmediata, pero la ficha de catálogo destaca a un vendedor más barato que declara días de preparación. Es un aviso para decidir, no una orden de bajar el precio.', pierde.map(c => marca(c) + casoPierde(c)).join(''), pierde.length)}
${seccion('Oportunidades de subida', 'Libros donde la entrega inmediata puede justificar un mejor precio: sin competidores en la ficha, o con competidores que venden a pedido. Ningún precio se modifica desde acá.', oportunidades.map(o => marca({ item: o.item, tipo: 'oportunidad' }) + casoOportunidad(o)).join(''), oportunidades.length)}
${seccion('Posibles errores de configuración', 'Condiciones de nuestras publicaciones que conviene revisar.', errores.length ? `<ul>${errores.map(c => filaSimple(c)).join('')}</ul>` : '', errores.length)}
${seccion('Casos que requieren una decisión', 'No somos la oferta destacada, pero el motivo no es un competidor con plazo: hay que mirarlos uno por uno.', decidir.length ? `<ul>${decidir.map(c => `<li>${marca(c)}${link(c.item.enlace, c.item.titulo)} — ${esc(c.texto)} ${c.ganador ? `Destacada: ${link(c.ganador.enlace, c.ganador.item_id)} a ${money(c.ganador.precio)}.` : ''}</li>`).join('')}</ul>` : '', decidir.length)}
${seccion('Consultas incompletas o fallidas', 'Publicaciones donde no se pudo comprobar la competencia. No significa que no haya competencia.', incompletas.length ? `<ul>${incompletas.slice(0, 200).map(c => `<li>${link(c.item.enlace, c.item.titulo)} — ${esc(c.motivo)}</li>`).join('')}${incompletas.length > 200 ? `<li>… y ${incompletas.length - 200} más</li>` : ''}</ul>` : '', incompletas.length)}
<p class="metricas">Duración ${Math.round(metricas.duracion_ms / 1000)} s · ${metricas.llamadas} llamadas a la API (${metricas.reintentos} reintentos, ${metricas.errores} errores) · fuente: API oficial de Mercado Libre, token de aplicación · sin IA ni scraping.</p>
</body></html>`;
}
