/**
 * functions/_shared/panel-google.js
 *
 * PANEL-DATOS-1 — visitas reales (GA4) y búsquedas en Google (Search Console).
 *
 * El panel no habla con Google: lee de KV (panel:google) el resumen que deja
 * el workflow panel-google.yml cada 3 horas (scripts/panel/fetch-google-panel.mjs).
 * Así el Worker no necesita credencial y abrir el panel no gasta cuota.
 * Si el resumen no está o es viejo, se dice; nunca se muestra como cero.
 */

export const PANEL_GOOGLE_KEY = 'panel:google';
const STALE_MS = 12 * 60 * 60 * 1000;

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function entero(value) {
  return escapeHtml(Math.round(num(value)).toLocaleString('es-UY'));
}

function pct(parte, total) {
  return total > 0 ? `${Math.round((parte / total) * 100)}%` : '—';
}

/** Variación contra el período anterior, con color y palabra. */
function variacion(actual, anterior) {
  const a = num(actual), b = num(anterior);
  if (!b) return '';
  const cambio = Math.round(((a - b) / b) * 100);
  const clase = cambio > 0 ? 'ok' : cambio < 0 ? 'err' : 'muted';
  return ` <small class="${clase}">${cambio > 0 ? '+' : ''}${cambio}% vs 28 días antes</small>`;
}

function table(headers, rows, renderRow, vacio = 'Sin datos.') {
  if (!rows?.length) return `<p class="empty">${escapeHtml(vacio)}</p>`;
  return `<div class="scroll"><table>
    <thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(renderRow).join('')}</tbody>
  </table></div>`;
}

function barra(valor, maximo) {
  const ancho = maximo > 0 ? Math.max(2, Math.round((num(valor) / maximo) * 100)) : 0;
  return `<span class="barrita" aria-hidden="true"><i style="width:${ancho}%"></i></span>`;
}

function stat(valor, texto, extra = '') {
  return `<div class="stat"><b>${valor}</b><span>${escapeHtml(texto)}${extra}</span></div>`;
}

function columnas(dias, campo, etiqueta) {
  if (!dias?.length) return '';
  const ancho = 720, alto = 120, abajo = 18, arriba = 16;
  const maximo = Math.max(1, ...dias.map(d => num(d[campo])));
  const paso = ancho / dias.length;
  const anchoBarra = Math.max(3, paso - 3);
  const util = alto - abajo - arriba;
  const barras = dias.map((d, i) => {
    const h = (num(d[campo]) / maximo) * util;
    const x = paso * i + (paso - anchoBarra) / 2;
    const marca = i === dias.length - 1 || (i % 7 === 0 && i < dias.length - 4);
    return `<g><rect class="blanco" x="${(paso * i).toFixed(1)}" y="0" width="${paso.toFixed(1)}" height="${alto - abajo}"><title>${escapeHtml(d.day)}: ${entero(d[campo])} ${escapeHtml(etiqueta)}</title></rect>
      ${h > 0 ? `<rect class="barra" x="${x.toFixed(1)}" y="${(arriba + util - h).toFixed(1)}" width="${anchoBarra.toFixed(1)}" height="${h.toFixed(1)}" rx="2"></rect>` : ''}
      ${marca ? `<text class="eje" x="${(paso * i + paso / 2).toFixed(1)}" y="${alto - 4}">${escapeHtml(String(d.day).slice(5))}</text>` : ''}</g>`;
  }).join('');
  return `<figure class="grafico"><svg viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="${escapeHtml(etiqueta)} por día">
    <line class="base" x1="0" y1="${alto - abajo}" x2="${ancho}" y2="${alto - abajo}"></line>${barras}</svg></figure>`;
}

/** Sólo rutas propias como enlace: lo que llega de GA4 puede venir de spam. */
function enlace(ruta, texto) {
  const r = String(ruta || '');
  if (!/^\/(?![/\\])/.test(r)) return escapeHtml(texto || r || '—');
  return `<a href="${escapeHtml(r)}">${escapeHtml(texto || r)}</a>`;
}

function rutaDe(url) {
  try { return new URL(url).pathname; } catch { return String(url || ''); }
}

export async function loadGoogle(kv, { now = Date.now() } = {}) {
  // Sin KV (tests, dev) es lo mismo que «todavía no llegó»: no es una falla.
  if (!kv || typeof kv.get !== 'function') return { missing: true };
  const data = await kv.get(PANEL_GOOGLE_KEY, 'json');
  if (!data) return { missing: true };
  const at = Date.parse(data.generatedAt || '');
  return { ...data, stale: !Number.isFinite(at) || now - at > STALE_MS };
}

const EVENTO = {
  view_item: 'vieron un libro', add_to_cart: 'agregaron al carrito', view_cart: 'abrieron el carrito',
  begin_checkout: 'empezaron a pagar', purchase: 'compraron', whatsapp_click: 'tocaron WhatsApp',
  book_request_submitted: 'pidieron un libro', stock_waitlist_created: 'pidieron aviso de stock',
};
const CANAL = {
  'Organic Search': 'Google y buscadores', Direct: 'Directo', 'Organic Social': 'Redes (orgánico)',
  Referral: 'Otros sitios', 'Paid Search': 'Google Ads', 'Paid Shopping': 'Shopping pago',
  'Organic Shopping': 'Shopping gratis', 'Paid Social': 'Redes (pago)', Email: 'Correo',
  Unassigned: 'Sin asignar', 'Cross-network': 'Varias redes (pago)', 'Organic Video': 'Video',
};
const DISPOSITIVO = { mobile: 'celular', desktop: 'computadora', tablet: 'tablet' };

export function ga4Section(g) {
  if (g.missing) {
    return `<p class="muted">Todavía no hay datos de GA4 en el panel. Los trae el workflow
      «Panel — visitas y búsquedas de Google» cada 3 horas; se puede correr a mano desde Actions.</p>`;
  }
  const aviso = g.stale ? `<p class="err">Estos datos son del ${escapeHtml(String(g.generatedAt).slice(0, 16).replace('T', ' '))} UTC: el workflow no está actualizando.</p>` : '';
  const ga = g.ga4 || {};
  if (ga.error) return `${aviso}<p class="err">GA4: ${escapeHtml(ga.error)}</p>`;
  const t = ga.totals || {}, p = ga.previousTotals || {};
  const win = g.ga4Window?.current;
  const canalesMax = Math.max(0, ...(ga.channels || []).map(r => num(r.sessions)));
  const totalSesiones = num(t.sessions);
  const embudo = Object.keys(EVENTO).filter(k => k in (ga.events || {}) || k in (ga.previousEvents || {}));
  const minutos = num(t.averageSessionDuration) / 60;

  return `${aviso}
  <p class="muted">Del ${escapeHtml(win?.startDate || '—')} al ${escapeHtml(win?.endDate || '—')} ·
    actualizado ${escapeHtml(String(g.generatedAt || '').slice(0, 16).replace('T', ' '))} UTC</p>
  <div class="grid">
    ${stat(entero(t.activeUsers), 'personas', variacion(t.activeUsers, p.activeUsers))}
    ${stat(entero(t.newUsers), 'nuevas', variacion(t.newUsers, p.newUsers))}
    ${stat(entero(t.sessions), 'visitas', variacion(t.sessions, p.sessions))}
    ${stat(pct(num(t.engagedSessions), totalSesiones), 'visitas con interés real')}
    ${stat(entero(t.screenPageViews), 'páginas vistas', variacion(t.screenPageViews, p.screenPageViews))}
    ${stat(`${Math.floor(minutos)}:${String(Math.round((minutos % 1) * 60)).padStart(2, '0')}`, 'minutos por visita')}
  </div>
  <h3>Personas por día</h3>
  ${columnas(ga.daily, 'users', 'personas')}
  ${embudo.length ? `<h3>Qué hicieron</h3>
  ${table(['Acción', 'Veces', 'Por cada 100 visitas', '28 días antes'], embudo, k => `
    <tr><td>${escapeHtml(EVENTO[k])}</td><td><b>${entero(ga.events?.[k])}</b></td>
        <td>${totalSesiones ? escapeHtml((num(ga.events?.[k]) / totalSesiones * 100).toFixed(1)) : '—'}</td>
        <td>${entero(ga.previousEvents?.[k])}</td></tr>`)}` : ''}
  <h3>De dónde vienen</h3>
  ${table(['Canal', 'Visitas', '', '% del total', 'Con interés'], ga.channels, r => `
    <tr><td>${escapeHtml(CANAL[r.sessionDefaultChannelGroup] || r.sessionDefaultChannelGroup)}</td>
        <td><b>${entero(r.sessions)}</b></td><td class="col-barra">${barra(r.sessions, canalesMax)}</td>
        <td>${pct(num(r.sessions), totalSesiones)}</td><td>${pct(num(r.engagedSessions), num(r.sessions))}</td></tr>`)}
  <details class="tabla-datos"><summary>Fuentes en detalle</summary>
  ${table(['Fuente', 'Medio', 'Visitas'], ga.sources, r => `
    <tr><td>${escapeHtml(r.sessionSource)}</td><td>${escapeHtml(r.sessionMedium)}</td><td>${entero(r.sessions)}</td></tr>`)}
  </details>
  <h3>Por dónde entran</h3>
  ${table(['Página de entrada', 'Visitas', 'Con interés'], ga.landings, r => `
    <tr><td>${enlace(r.landingPage, r.landingPage || '(sin página)')}</td>
        <td>${entero(r.sessions)}</td><td>${pct(num(r.engagedSessions), num(r.sessions))}</td></tr>`)}
  <details class="tabla-datos"><summary>Páginas más vistas</summary>
  ${table(['Página', 'Vistas', 'Personas'], ga.pages, r => `
    <tr><td>${enlace(r.pagePath, r.pageTitle || r.pagePath)}<br><small class="muted">${escapeHtml(r.pagePath)}</small></td>
        <td>${entero(r.screenPageViews)}</td><td>${entero(r.activeUsers)}</td></tr>`)}
  </details>
  <div class="dos-columnas">
    <div><h3>Dispositivo</h3>
    ${table(['Dispositivo', 'Visitas', '%'], ga.devices, r => `
      <tr><td>${escapeHtml(DISPOSITIVO[r.deviceCategory] || r.deviceCategory)}</td><td>${entero(r.sessions)}</td>
          <td>${pct(num(r.sessions), totalSesiones)}</td></tr>`)}</div>
    <div><h3>Ciudades</h3>
    ${table(['Ciudad', 'Personas'], ga.cities, r => `
      <tr><td>${escapeHtml(r.city === '(not set)' ? '(sin dato)' : r.city)}</td><td>${entero(r.activeUsers)}</td></tr>`)}</div>
  </div>`;
}

export function searchConsoleSection(g) {
  if (g.missing) return '<p class="muted">Todavía no hay datos de Search Console en el panel.</p>';
  const s = g.gsc || {};
  if (s.error) return `<p class="err">Search Console: ${escapeHtml(s.error)}</p>`;
  const t = s.totals || {}, p = s.previousTotals || {};
  const win = g.gscWindow?.current;
  const maxQ = Math.max(0, ...(s.queries || []).map(r => num(r.clicks)));
  return `
  <p class="muted">Del ${escapeHtml(win?.startDate || '—')} al ${escapeHtml(win?.endDate || '—')} (Google publica estos datos con 2-3 días de atraso).</p>
  <div class="grid">
    ${stat(entero(t.clicks), 'clics desde Google', variacion(t.clicks, p.clicks))}
    ${stat(entero(t.impressions), 'veces que aparecimos', variacion(t.impressions, p.impressions))}
    ${stat(`${(num(t.ctr) * 100).toFixed(1)}%`, 'de los que nos ven, entran')}
    ${stat(escapeHtml(num(t.position).toFixed(1)), 'posición media', p.position ? ` <small class="muted">antes ${escapeHtml(num(p.position).toFixed(1))}</small>` : '')}
  </div>
  <h3>Clics por día</h3>
  ${columnas(s.daily, 'clicks', 'clics')}
  <h3>Qué buscan en Google para llegar</h3>
  ${table(['Búsqueda', 'Clics', '', 'Apariciones', 'CTR', 'Posición'], s.queries, r => `
    <tr><td>${escapeHtml(r.query)}</td><td><b>${entero(r.clicks)}</b></td><td class="col-barra">${barra(r.clicks, maxQ)}</td>
        <td>${entero(r.impressions)}</td><td>${(num(r.ctr) * 100).toFixed(1)}%</td><td>${escapeHtml(num(r.position).toFixed(1))}</td></tr>`)}
  <details class="tabla-datos"><summary>Páginas que más aparecen en Google</summary>
  ${table(['Página', 'Clics', 'Apariciones', 'Posición'], s.pages, r => `
    <tr><td>${enlace(rutaDe(r.page))}</td><td>${entero(r.clicks)}</td>
        <td>${entero(r.impressions)}</td><td>${escapeHtml(num(r.position).toFixed(1))}</td></tr>`)}
  </details>`;
}
