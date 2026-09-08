import { verifyAdminAccess } from './_shared/admin-web-auth.js';
import { webPeriod, readWebOrders, readWebEmails, readWebCatalog, readWebSync, readWebAnalytics } from './_shared/admin-web-data.js';
import { renderAdminWeb } from './_shared/admin-web-view.js';

const HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const respond = (body, status = 200, type = 'text/plain; charset=utf-8', extra = {}) =>
  new Response(body, { status, headers: { ...HEADERS, 'Content-Type': type, ...extra } });

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (env.ADMIN_WEB_ENABLED !== 'true' || !['preview', 'production'].includes(env.APP_ENV) ||
      !env.ADMIN_WEB_HOST || url.hostname !== env.ADMIN_WEB_HOST || url.protocol !== 'https:') return respond('No encontrado', 404);
  if (!(await verifyAdminAccess(request, env))) return respond('Acceso privado. Ingresá con una cuenta autorizada.', 403);
  if (!['GET', 'HEAD'].includes(request.method)) return respond('Sólo consulta', 405, undefined, { Allow: 'GET, HEAD' });
  if (request.method === 'HEAD') return respond(null, 200);
  const days = Number(url.searchParams.get('days') || 7);
  const view = url.searchParams.get('view') || 'resumen';
  const page = Number(url.searchParams.get('page') || 0);
  if (![7, 30].includes(days) || !['resumen','visitas','compra','pedidos','productos','estado'].includes(view) ||
      !Number.isSafeInteger(page) || page < 0 || page > 10000 || (url.searchParams.get('q') || '').length > 120) return respond('Filtro inválido', 400);
  const now = new Date();
  const period = webPeriod(days, now);
  const model = { view, period, checkedAt: now.toISOString(), environment: env.APP_ENV,
    dataEnvironment: env.ADMIN_WEB_DATA_ENV || env.APP_ENV,
    query: url.searchParams.get('q') || '' };
  const readers = [];
  const collect = (key, promise) => readers.push(promise.then(value => { model[key] = value; }));
  if (['resumen','visitas','compra'].includes(view)) collect('analytics', readWebAnalytics(env, period, now));
  if (['resumen','pedidos'].includes(view)) collect('orders', readWebOrders(env, period));
  if (['resumen','compra','estado'].includes(view)) collect('emails', readWebEmails(env, period));
  if (['resumen','estado'].includes(view)) collect('sync', readWebSync(fetch, now));
  if (view === 'productos') collect('catalog', readWebCatalog(model.query, page));
  await Promise.all(readers);
  return url.searchParams.get('format') === 'json'
    ? respond(JSON.stringify(model), 200, 'application/json; charset=utf-8')
    : respond(renderAdminWeb(model), 200, 'text/html; charset=utf-8');
}
