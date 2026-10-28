// /panel/oportunidades — bandeja de decisiones: cada sugerencia (subir precio,
// reponer, tener con entrega inmediata) con título, tapa, ISBN, enlaces,
// evidencia, fecha y acción, y su estado: pendiente, aprobado, descartado,
// pedido, recibido, resultado. Sólo lectura de datos; lo único que escribe es
// el estado y una nota. No cambia precios ni compra nada.
// Con sesión del panel y en producción. HTML sin JavaScript.
import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { listOpportunities, opportunitySummary, setOpportunityState, OPPORTUNITY_STATES, OPPORTUNITY_TYPES } from '../../worker-sync/oportunidades.js';
import { lastPriceReview } from '../../worker-sync/precios-catalogo.js';

const ORIGIN = 'https://www.amadolibros.com';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = v => v == null ? '—' : `$ ${Math.round(v).toLocaleString('es-UY')}`;
const day = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';
const STATE_LABEL = { pendiente: 'Pendiente', aprobado: 'Aprobado', descartado: 'Descartado', pedido: 'Pedido', recibido: 'Recibido', resultado: 'Con resultado', todas: 'Todas' };
const STATE_TONE = { pendiente: 'aviso', aprobado: 'bien', descartado: 'gris', pedido: 'bien', recibido: 'bien', resultado: 'gris' };
const CONF_TONE = { alta: 'bien', media: 'aviso', baja: 'grave' };

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Oportunidades</title>
<style>
body{font:15px system-ui;margin:0;padding:16px;line-height:1.45;color:#222;background:#faf8f4}main{max-width:1300px;margin:0 auto}h1{margin:.2em 0}h2{font-size:18px;margin:28px 0 8px}
.card{background:#fff;border:1px solid #e6e0d6;border-radius:10px;padding:14px 16px;margin:12px 0}.muted{color:#777;font-size:13px}a{color:#a94e3d}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:7px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#666}td.n,th.n{text-align:right;white-space:nowrap}.scroll{overflow-x:auto}
.p{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}.p-bien{background:#e7f5ea;color:#1b6b30}.p-aviso{background:#fff4d6;color:#8a5a00}.p-grave{background:#fde8e4;color:#9a2b18}.p-gris{background:#eee;color:#555}
.tabs a{display:inline-block;margin:0 8px 8px 0;padding:6px 12px;border-radius:99px;border:1px solid #e6e0d6;background:#fff;text-decoration:none;color:#444}.tabs a.aqui{background:#a94e3d;color:#fff;border-color:#a94e3d}
.tapa{width:48px;height:64px;object-fit:cover;border-radius:4px;background:#eee}.tit{font-weight:600}.ev{font-size:13px;color:#444;max-width:420px}
form.est{display:flex;gap:6px;flex-wrap:wrap;align-items:center}select,input[type=text]{font:inherit;padding:5px;border:1px solid #ccc;border-radius:6px}button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid #a94e3d;background:#a94e3d;color:#fff;cursor:pointer}
.ok{background:#e7f5ea;color:#1b6b30;padding:8px 12px;border-radius:8px}
</style><main><p><a href="/panel">← Panel</a> · <a href="/panel/reposicion">Reposición</a> · <a href="/panel/inteligencia">Brújula</a></p>${body}</main></html>`, {
    status, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src https://http2.mlstatic.com https://*.mlstatic.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

function evidence(o) {
  const e = o.evidencia ?? {};
  const bits = [];
  if (e.texto) bits.push(esc(e.texto));
  if (Array.isArray(e.rango_prueba) && e.rango_prueba.length > 1) bits.push(`<span class="muted">Rango de prueba: ${e.rango_prueba.map(v => esc(money(v))).join(' → ')} (pasos de ${esc(e.params?.probe_step_pct ?? 5)} %)</span>`);
  if (e.costo || e.contribucion) bits.push(`<span class="muted">${e.costo ? `Costo ${esc(money(e.costo.valor))} (${esc(e.costo.proveedor)}, ${esc(day(e.costo.fecha))})` : 'Costo: sin cargar'}${e.comision?.tasa != null ? ` · comisión ${esc(Math.round(e.comision.tasa * 1000) / 10)} %` : ' · comisión: sin dato'}${e.flete == null ? ' · flete: sin dato' : ` · flete ${esc(money(e.flete))}`}${e.contribucion?.sugerida != null ? ` · te quedan ${esc(money(e.contribucion.actual))} → <b>${esc(money(e.contribucion.sugerida))}</b>` : ''}</span>`);
  const foto = e.foto ? `Foto de ML del ${esc(day(e.foto))}${e.foto_edad_horas != null ? ` (hace ${esc(e.foto_edad_horas)} h)` : ''}${e.segmento ? ` · ${esc(e.segmento)}` : ''}` : 'Sin foto de competencia';
  bits.push(`<span class="muted">${foto}${e.costo_conocido === false && !e.costo ? ' · costo no cargado' : ''}${Array.isArray(e.faltantes) && e.faltantes.length ? ` · faltan: ${esc(e.faltantes.join(', '))}` : ''}${e.nivel ? ` · ${esc(e.nivel)}` : ''}</span>`);
  return bits.join('<br>');
}

function row(o, estadoActual) {
  const l = o.enlaces ?? {};
  const links = [l.ml ? `<a href="${esc(l.ml)}" rel="noopener noreferrer">ML</a>` : '', `<a href="/panel/reposicion?q=${esc(o.isbn)}">reposición</a>`].filter(Boolean).join(' · ');
  const options = OPPORTUNITY_STATES.map(s => `<option value="${s}"${s === o.estado ? ' selected' : ''}>${esc(STATE_LABEL[s])}</option>`).join('');
  return `<tr>
    <td>${l.tapa ? `<img class="tapa" src="${esc(l.tapa)}" alt="" loading="lazy">` : ''}</td>
    <td><div class="tit">${esc(o.titulo ?? o.isbn)}</div><small class="muted">${esc(o.isbn)} · ${links}</small></td>
    <td><span class="p p-gris">${esc(OPPORTUNITY_TYPES[o.tipo] ?? o.tipo)}</span><br><b>${esc(o.accion ?? '')}</b>${o.cantidad != null && o.tipo !== 'subir_precio' ? `<br><small class="muted">cantidad ${esc(o.cantidad)}${o.cantidad_nivel ? ` · ${esc(o.cantidad_nivel)}` : ''}</small>` : ''}</td>
    <td class="n">${money(o.impacto_mes)}</td>
    <td><span class="p p-${CONF_TONE[o.confianza] ?? 'gris'}">${esc(o.confianza ?? '—')}</span></td>
    <td class="ev">${evidence(o)}</td>
    <td class="n"><small>${esc(day(new Date(Number(o.last_seen_at)).toISOString()))}${o.vigente ? '' : '<br><span class="p p-gris">ya no se observa</span>'}${o.notificado_at ? '<br><span class="muted">avisada por correo</span>' : ''}</small></td>
    <td><span class="p p-${STATE_TONE[o.estado] ?? 'gris'}">${esc(STATE_LABEL[o.estado] ?? o.estado)}</span>${o.nota ? `<br><small class="muted">${esc(o.nota)}</small>` : ''}
      <form class="est" method="post" action="/panel/oportunidades?estado=${esc(estadoActual)}"><input type="hidden" name="id" value="${esc(o.id)}"><select name="estado">${options}</select><input type="text" name="nota" placeholder="nota" maxlength="500"><button type="submit">Guardar</button></form></td>
  </tr>`;
}

function priceReviewBlock(r) {
  if (!r) return '';
  return `<p class="muted">Última revisión de precios de todo el catálogo con foto (${esc(day(r.generado))}): ${esc(r.fichas_vigiladas)} fichas vigiladas, ${esc(r.con_foto)} con foto completa, ${esc(r.con_suba)} con margen para subir (${esc(r.firmes)} firmes, ${esc(r.provisionales)} provisionales), ${esc(r.sin_suba)} sin suba, ${esc(r.bloqueadas)} bloqueadas; ${esc(r.sin_costo)} sin costo cargado, ${esc(r.sin_comision)} sin comisión conocida. Reglas: sugerido ${esc(r.params?.undercut_pct)} % debajo del más barato comparable si está ${esc(r.params?.min_gap_pct)} % o más arriba; sin referencia, probar de a ${esc(r.params?.probe_step_pct)} % hasta ${esc(r.params?.probe_max_pct)} %.</p>`;
}

export function renderOportunidades({ resumen, lista, estado, hecho = false, revision = null }) {
  const tabs = ['pendiente', 'aprobado', 'pedido', 'recibido', 'resultado', 'descartado', 'todas'].map(s => `<a class="${s === estado ? 'aqui' : ''}" href="/panel/oportunidades?estado=${s}">${esc(STATE_LABEL[s])}${s !== 'todas' ? ` (${resumen.por_estado[s]?.total ?? 0})` : ''}</a>`).join('');
  const rows = lista.map(o => row(o, estado)).join('');
  return `<h1>Oportunidades</h1>
  <p class="muted">Cada fila es una decisión con su evidencia: qué dice la foto de competencia de Mercado Libre, cuánto vendiste, qué costo hay cargado y cuánto falta para afirmarla. Ordenadas por plata por mes sustentada y confianza. El panel sólo sugiere: los precios se cambian en Mercado Libre y las compras se hacen con el proveedor.</p>
  ${hecho ? '<p class="ok">Estado guardado.</p>' : ''}
  <div class="tabs">${tabs}</div>
  ${priceReviewBlock(revision)}
  <p class="muted">${resumen.pendientes_vigentes} pendiente${resumen.pendientes_vigentes === 1 ? '' : 's'} observada${resumen.pendientes_vigentes === 1 ? '' : 's'} en los últimos 3 días · ${resumen.sin_avisar} todavía sin avisar por correo. "Ya no se observa" = la última recalculada no la encontró; conserva su estado por si vuelve.</p>
  ${lista.length ? `<div class="card scroll"><table><thead><tr><th></th><th>Libro</th><th>Qué hacer</th><th class="n">Más por mes</th><th>Confianza</th><th>Evidencia</th><th class="n">Vista</th><th>Estado</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : '<div class="card"><p class="muted">No hay oportunidades en este estado. La bandeja se recalcula cada mañana con el correo del panel.</p></div>'}
  <p class="muted">Confianza alta = 2 o más competidores comparables observados y costo cargado; media = una sola referencia o sin costo; baja = sin stock, foto de más de 48 horas o captura incompleta. Cantidad = objetivo − stock físico − en camino; 2 o 3 unidades sólo con repetición real de ventas, costo y ventana completa.</p>`;
}

export function createOportunidadesPanel({ now = Date.now } = {}) {
  return async context => {
    const { request, env } = context;
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || env.APP_ENV !== 'production') return page('<p>No disponible.</p>', 403);
    const config = resolvePanelConfig(env);
    if (!config.ok || !await hasValidSession(request, await deriveSessionSecret(config.password))) return Response.redirect(`${ORIGIN}/panel`, 303);
    const db = env.ORDERS_DB;
    if (!db) return page('<p>Sin base de datos en este entorno.</p>', 503);
    const estadoParam = url.searchParams.get('estado') ?? 'pendiente';
    const estado = estadoParam === 'todas' || OPPORTUNITY_STATES.includes(estadoParam) ? estadoParam : 'pendiente';
    if (request.method === 'POST') {
      // Mismo origen: el formulario sale de esta página; un sitio ajeno no puede
      // mandarlo con la cookie del panel.
      const origin = request.headers.get('origin');
      if (origin && origin !== ORIGIN) return page('<p>Origen no permitido.</p>', 403);
      const form = await request.formData();
      const id = String(form.get('id') ?? '').slice(0, 80), nuevo = String(form.get('estado') ?? ''), nota = String(form.get('nota') ?? '').trim().slice(0, 500);
      if (!/^[a-z_]+:\d{10,13}$/.test(id) || !OPPORTUNITY_STATES.includes(nuevo)) return page('<p>Datos inválidos.</p>', 400);
      await setOpportunityState(db, id, nuevo, { nota: nota || null, nowMs: now() });
      return Response.redirect(`${ORIGIN}/panel/oportunidades?estado=${encodeURIComponent(estado)}&hecho=1`, 303);
    }
    if (request.method !== 'GET') return page('<p>Método no permitido.</p>', 405);
    try {
      const [resumen, lista, revision] = await Promise.all([opportunitySummary(db, now()), listOpportunities(db, { estado, limit: 200, nowMs: now() }), lastPriceReview(db)]);
      return page(renderOportunidades({ resumen, lista, estado, hecho: url.searchParams.get('hecho') === '1', revision }));
    } catch (error) {
      return page(`<h1>Oportunidades</h1><p class="p p-grave">No se pudo armar la vista: ${esc(error?.code || error?.message || 'error')}</p>`, 500);
    }
  };
}

export const onRequest = createOportunidadesPanel();
