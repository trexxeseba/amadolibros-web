// /panel/reposicion — hechos del motor de reposición por libro: stock propio,
// ventas ML (stock propio y encargo SBS), compras, en tránsito, SBS y el estado
// de los datos (FUENTE INCOMPLETA / REVISAR / LISTO PARA DECIDIR). Sólo lectura,
// con sesión del panel y en producción. HTML sin JavaScript.
// No decide cuánto comprar: muestra los datos para decidir.
import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { fetchCatalog } from '../_shared/catalog.js';
import { createReposicionFacts } from '../../worker-sync/reposicion-facts.js';
import { salesByTitle } from '../../worker-sync/ml-sales.js';
import { bookIsbn } from '../../worker-sync/isbn.js';
import { REQUIRED_SUPPLIERS } from '../../worker-sync/purchases.js';

const ORIGIN = 'https://www.amadolibros.com';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SUPPLIER_NAMES = { CELESA: 'Celesa', ARNOIA: 'Arnoia', CASASSA_Y_LORENZO: 'Casassa y Lorenzo', AMAZON_COM: 'Amazon.com', AMAZON_ES: 'Amazon.es', SBS: 'SBS' };
const supplierName = s => String(s ?? '').split(',').map(x => SUPPLIER_NAMES[x] ?? x).join(', ');
const REASONS = {
  ventas_ml_desactualizadas: 'Las ventas de Mercado Libre no se están actualizando.',
  stock_propio_desactualizado: 'El stock del catálogo tiene más de 48 horas.',
  compras_sin_isbn_posibles: 'Hay compras sin ISBN que podrían ser este libro.',
  publicaciones_con_stock_distinto: 'Las publicaciones activas tienen cantidades distintas.',
  posible_demanda_censurada: 'Sin stock: vendía y dejó de vender, probablemente por falta de stock.',
  encargo_sbs_supera_propio: 'Se vende más por encargo SBS que de stock: evaluar pasarlo a stock.',
  posible_sobrestock: 'Stock + en tránsito ya cubre las ventas de 6 meses.',
};
const reason = code => code.startsWith('compras_no_cargadas:')
  ? `Sin compras registradas y faltan cargar compras de: ${supplierName(code.split(':')[1])}.`
  : REASONS[code] ?? code;
const STATE = { 'FUENTE INCOMPLETA': ['grave', 'Fuente incompleta'], REVISAR: ['aviso', 'Revisar'], LISTO_PARA_DECIDIR: ['bien', 'Listo para decidir'] };
const day = iso => iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—';

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Reposición</title>
<style>
body{font:15px system-ui;margin:0;padding:16px;line-height:1.45;color:#222;background:#faf8f4}
main{max-width:1300px;margin:0 auto}h1{margin:.2em 0}h2{font-size:18px;margin:28px 0 8px}
.card{background:#fff;border:1px solid #e6e0d6;border-radius:10px;padding:14px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{padding:7px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;color:#666;letter-spacing:.02em}td.n,th.n{text-align:right;white-space:nowrap}
.scroll{overflow-x:auto}.muted{color:#777;font-size:13px}.tit{font-weight:600}small{color:#777}
.p{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.p-bien{background:#e7f5ea;color:#1b6b30}.p-aviso{background:#fff4d6;color:#8a5a00}.p-grave{background:#fde8e4;color:#9a2b18}
ul.r{margin:4px 0 0;padding-left:16px;font-size:12px;color:#555}form{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=text]{font:inherit;padding:8px;min-width:280px;flex:1;border:1px solid #ccc;border-radius:6px}button,.btn{font:inherit;padding:8px 14px;border-radius:6px;border:1px solid #a94e3d;background:#a94e3d;color:#fff;cursor:pointer;text-decoration:none}
.btn.sec{background:#fff;color:#a94e3d}a{color:#a94e3d}
</style><main><p><a href="/panel">← Panel</a></p>${body}</main></html>`, {
    status, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

function globalBlock(g) {
  const covered = new Map(g.coverage.map(c => [c.supplier, c]));
  const rows = REQUIRED_SUPPLIERS.map(s => {
    const c = covered.get(s), ok = !g.missing.includes(s);
    return `<tr><td>${esc(supplierName(s))}</td><td>${c ? `${day(c.covered_from)} → ${day(c.covered_to)}` : '<span class="muted">sin cargar</span>'}</td><td><span class="p p-${ok ? 'bien' : 'aviso'}">${ok ? '12 meses completos' : 'incompleta'}</span></td><td class="muted">${esc(c?.note ?? '')}</td></tr>`;
  }).join('');
  const warn = g.flags.map(f => `<li>${esc(reason(f))}</li>`).join('');
  return `<div class="card">
  ${warn ? `<p><span class="p p-grave">Atención</span></p><ul>${warn}</ul>` : ''}
  <p class="muted">${g.health.notas.map(esc).join(' · ')} · Catálogo actualizado ${esc(day(g.catalog_updated_at))}</p>
  <div class="scroll"><table><thead><tr><th>Proveedor</th><th>Compras cargadas</th><th>Cobertura</th><th>Nota</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p class="muted">Si un proveedor no tiene 12 meses cargados, "no le compramos" no se puede afirmar y el libro queda en <b>Fuente incompleta</b>.</p></div>`;
}

function factsTable(results) {
  if (!results.length) return '<p class="muted">No hay libros para mostrar.</p>';
  const rows = results.map(r => {
    if (!r.isbn) return `<tr><td colspan="9"><span class="p p-grave">ISBN inválido</span> ${esc(r.input)}</td></tr>`;
    const [tone, label] = STATE[r.estado_datos] ?? ['aviso', r.estado_datos];
    const motives = [...r.fuente_incompleta, ...r.revisar].map(reason);
    const pubs = r.publicaciones.map(p => `<a href="https://articulo.mercadolibre.com.uy/${esc(p.id.replace(/^MLU/, 'MLU-'))}" rel="noopener noreferrer">${esc(p.id)}</a>${p.estado !== 'active' ? ` <small>(${esc(p.estado)})</small>` : ''}`).join(', ');
    const v = r.ventas, c = r.compras;
    const sbs = r.sbs.feed_fecha ? `${esc(r.sbs.disponible === 'no_figura' ? 'no figura' : r.sbs.disponible)}${r.sbs.vigente ? '' : ' <small>(feed viejo)</small>'}` : '<small>sin feed</small>';
    return `<tr>
      <td><div class="tit">${esc(r.titulo ?? '—')}</div><small>${esc(r.isbn)}${pubs ? ` · ${pubs}` : ''}</small></td>
      <td class="n"><b>${r.stock_propio}</b></td>
      <td class="n">${v.propio.d30} · ${v.propio.d90} · ${v.propio.d365}</td>
      <td class="n">${v.encargo_sbs.d365 || '—'}</td>
      <td class="n">${esc(day(v.ultima_venta))}</td>
      <td class="n">${c.d365}${c.ultima_fecha ? `<br><small>${esc(day(c.ultima_fecha))} · ${esc(supplierName(c.ultimo_proveedor))} · ${c.ultima_cantidad} u.</small>` : ''}</td>
      <td class="n">${c.en_transito_estimado || '—'}</td>
      <td class="n">${sbs}</td>
      <td><span class="p p-${tone}">${esc(label)}</span>${motives.length ? `<ul class="r">${motives.map(m => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}</td>
    </tr>`;
  }).join('');
  return `<div class="scroll"><table><thead><tr>
    <th>Libro</th><th class="n">Stock propio</th><th class="n">Ventas propias<br>30 · 90 · 365 d</th><th class="n">Encargo SBS<br>365 d</th><th class="n">Última venta</th>
    <th class="n">Compras 365 d<br><small>última</small></th><th class="n">En tránsito</th><th class="n">SBS</th><th>Estado de datos</th>
  </tr></thead><tbody>${rows}</tbody></table></div>`;
}

function identityBlock(q) {
  const v = q.ventas_sin_isbn.slice(0, 10).map(r => `<tr><td>${esc(r.titulo)}</td><td><small>${esc(r.item_id)}</small></td><td class="n">${r.unidades}</td><td class="n">${esc(day(r.ultima))}</td></tr>`).join('');
  const c = q.compras_sin_isbn.slice(0, 10).map(r => `<tr><td>${esc(r.titulo)}</td><td>${esc(supplierName(r.proveedor))} <small>${esc(r.documento ?? '')}</small></td><td class="n">${r.cantidad}</td><td class="n">${esc(day(r.fecha))}</td></tr>`).join('');
  return `<details class="card"><summary><b>Libros sin ISBN para identificar</b> <span class="muted">(no suman en los totales por ISBN)</span></summary>
  <h3>Ventas ML sin ISBN, por unidades</h3>${v ? `<div class="scroll"><table><thead><tr><th>Título</th><th>Publicación</th><th class="n">Unidades</th><th class="n">Última</th></tr></thead><tbody>${v}</tbody></table></div>` : '<p class="muted">Ninguna.</p>'}
  <h3>Compras sin ISBN, las más recientes</h3>${c ? `<div class="scroll"><table><thead><tr><th>Título</th><th>Proveedor</th><th class="n">Cantidad</th><th class="n">Fecha</th></tr></thead><tbody>${c}</tbody></table></div>` : '<p class="muted">Ninguna.</p>'}
  </details>`;
}

const searchForm = (q = '') => `<div class="card"><form method="get" action="/panel/reposicion">
  <input type="text" name="q" value="${esc(q)}" placeholder="ISBN (hasta 50, separados por coma o espacio) o parte del título" maxlength="1200">
  <button type="submit">Buscar</button><a class="btn sec" href="/panel/reposicion">Ver candidatos</a></form></div>`;

const LEGEND = `<p class="muted"><span class="p p-grave">Fuente incompleta</span> falta información para decidir ·
<span class="p p-aviso">Revisar</span> hay datos, pero algo pide mirar con cuidado ·
<span class="p p-bien">Listo para decidir</span> los datos están completos. Stock propio = publicación propia y de catálogo comparten ejemplar (se toma el máximo).
Encargo SBS = ventas con SKU AMADO-AR (señal para pasar a stock). En tránsito = compras de los últimos 15 días.</p>`;

export function createReposicionPanel({ factsFactory = ctx => createReposicionFacts({ loadCatalog: () => fetchCatalog(ctx) }) } = {}) {
  return async context => {
    const { request, env } = context;
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || env.APP_ENV !== 'production') return page('<p>No disponible.</p>', 403);
    const config = resolvePanelConfig(env);
    if (!config.ok || !await hasValidSession(request, await deriveSessionSecret(config.password))) return Response.redirect(`${ORIGIN}/panel`, 303);
    if (request.method !== 'GET') return page('<p>Método no permitido.</p>', 405);
    const db = env.ORDERS_DB;
    if (!db) return page('<p>Sin base de datos en este entorno.</p>', 503);
    const facts = factsFactory(context);
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 1200);
    try {
      const g = await facts.globalState(db);
      let title, body, extra = '';
      const tokens = q.split(/[\s,;]+/).filter(Boolean);
      const isbns = tokens.filter(t => bookIsbn(t));
      if (q && isbns.length && isbns.length === tokens.length) {
        const data = await facts.facts(db, isbns.slice(0, 50));
        title = `Búsqueda por ISBN (${Math.min(isbns.length, 50)})`;
        body = factsTable(data.resultados);
      } else if (q) {
        const found = q.length >= 4 ? await salesByTitle(db, q) : [];
        const withIsbn = [...new Set(found.filter(r => r.isbn).map(r => r.isbn))].slice(0, 50);
        const titleOnly = found.filter(r => !r.isbn);
        title = `Búsqueda por título: “${q}”`;
        body = withIsbn.length ? factsTable((await facts.facts(db, withIsbn)).resultados) : '<p class="muted">No hay ventas con ISBN para ese título.</p>';
        if (titleOnly.length) extra = `<h2>Ventas sin ISBN con ese título</h2><div class="scroll"><table><thead><tr><th>Título</th><th class="n">Ventas 365 d</th><th class="n">Última venta</th><th>Publicaciones</th></tr></thead><tbody>${titleOnly.map(r => `<tr><td>${esc(r.titulos[0] ?? '')}</td><td class="n">${r.ventas_365d}</td><td class="n">${esc(day(r.ultima_venta))}</td><td><small>${esc(r.item_ids.join(', '))}</small></td></tr>`).join('')}</tbody></table></div>`;
      } else {
        const data = await facts.candidates(db, 50);
        title = 'Candidatos a reponer';
        body = `<p class="muted">Libros con 2 o más ventas propias en el último año y stock propio de 0 o 1, ordenados por ventas de los últimos 90 días.</p>${factsTable(data.resultados)}`;
      }
      const queue = await facts.identityQueue(db, 10);
      return page(`<h1>Reposición</h1>${LEGEND}<h2>Estado de los datos</h2>${globalBlock(g)}${searchForm(q)}<h2>${esc(title)}</h2>${body}${extra}${identityBlock(queue)}`);
    } catch (error) {
      return page(`<h1>Reposición</h1>${searchForm(q)}<p class="p p-grave">No se pudo armar la vista: ${esc(error?.code || error?.message || 'error')}</p>`, error?.status && error.status < 500 ? error.status : 500);
    }
  };
}

export const onRequest = createReposicionPanel();
