// /panel/compras — carga manual de compras a proveedores (JSON normalizado que
// prepara GPT a partir de facturas y correos). Sólo con sesión del panel y en
// producción. Formulario sin JavaScript: se pega el JSON y se importa en D1
// con la misma lógica idempotente que POST /purchases/import del Worker.
import { deriveSessionSecret, hasValidSession, resolvePanelConfig } from '../_shared/panel-auth.js';
import { importPurchases } from '../../worker-sync/purchases.js';

const ORIGIN = 'https://www.amadolibros.com', MAX_BYTES = 512 * 1024;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function page(body, status = 200) {
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Compras a proveedores</title>
<style>body{font:17px system-ui;max-width:1000px;margin:4vh auto;padding:16px;line-height:1.5}textarea{width:100%;min-height:340px;font:14px ui-monospace,monospace;box-sizing:border-box}button{font:inherit;padding:10px 18px;margin:12px 0;cursor:pointer}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left;border-bottom:1px solid #ddd;vertical-align:top}.err{color:#9a3412;font-weight:600}.ok{color:#166534;font-weight:600}</style>
<p><a href="/panel">← Panel</a></p><h1>Compras a proveedores</h1>${body}</html>`, {
    status, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" },
  });
}

const form = (value = '') => `<p>Pegá un documento, una lista de documentos o <code>{"documents":[…]}</code>. Re-importar el mismo documento lo actualiza sin duplicar.</p>
<form method="post"><textarea name="json" required spellcheck="false">${esc(value)}</textarea><br><button type="submit">Importar compras</button></form>`;

function resultHtml(result) {
  const rows = result.results.map(r => r.status === 'imported'
    ? `<tr><td>${r.index}</td><td class="ok">importado</td><td><code>${esc(r.purchase_id)}</code></td><td>${r.lines} líneas · ${esc(Object.entries(r.match_methods).map(([k, v]) => `${k}: ${v}`).join(', '))}${r.review.length ? `<br><b>Para revisar:</b> ${r.review.map(x => `${esc(x.title)} (${esc(x.method)}${x.candidates.length ? `; candidatos ${esc(x.candidates.join(', '))}` : ''})`).join('; ')}` : ''}</td></tr>`
    : `<tr><td>${r.index}</td><td class="err">error</td><td colspan="2"><code>${esc(r.error)}</code></td></tr>`).join('');
  return `<p>Importados: <b>${result.imported}</b> · Con error: <b>${result.errors}</b></p><table><tr><th>#</th><th>Estado</th><th>Compra</th><th>Detalle</th></tr>${rows}</table>`;
}

export function createPurchasesPanel({ importer = importPurchases } = {}) {
  return async ({ request, env }) => {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || env.APP_ENV !== 'production') return page('<p>No disponible.</p>', 403);
    const config = resolvePanelConfig(env);
    if (!config.ok || !await hasValidSession(request, await deriveSessionSecret(config.password))) return Response.redirect(`${ORIGIN}/panel`, 303);
    if (request.method === 'GET') return page(form());
    if (request.method !== 'POST') return page('<p>Método no permitido.</p>', 405);
    if (request.headers.get('origin') !== ORIGIN) return page('<p class="err">Origen no válido.</p>', 403);
    if (Number(request.headers.get('content-length')) > MAX_BYTES) return page('<p class="err">El JSON supera 512 KB. Partilo en lotes.</p>', 413);
    const raw = String((await request.formData()).get('json') ?? '');
    let payload;
    try { payload = JSON.parse(raw); } catch { return page(`<p class="err">JSON inválido.</p>${form(raw)}`, 400); }
    try {
      return page(resultHtml(await importer(env.ORDERS_DB, payload)) + form());
    } catch (error) {
      return page(`<p class="err">No se pudo importar: <code>${esc(error?.code || 'internal_error')}</code></p>${form(raw)}`, error?.status || 500);
    }
  };
}

export const onRequest = createPurchasesPanel();
