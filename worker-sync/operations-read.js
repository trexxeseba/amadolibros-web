import { getAccessToken } from './meli-auth.js';

// Public verification key. The signing key is private to the owner-only Amado
// Operaciones app; no Mercado Libre credential is copied to that app.
export const OPERATIONS_PUBLIC_KEY = {
  kty: 'EC', crv: 'P-256',
  x: 'FNXAkSLY3AR1A7F6VtDLfPnWpKIzEvEgY_C_eJNdvL4',
  y: 'K2mb-jxAhWKPf3_NMwPNrz4XXrN4bw2lOrBGeD9Y1KU',
};
export const OPERATIONS_ISSUER = 'appgprj_6ad0d1c8b5d48191a2a60add6a0dea70';
export const OPERATIONS_PATH = '/operations/read';
const SELLER_ID = '440298103';
const APP_ID = '4741021817925208';
const ML_ORIGIN = 'https://api.mercadolibre.com';
const encoder = new TextEncoder();

class ReadError extends Error {
  constructor(message, status = 502, code = 'read_error') { super(message); this.status = status; this.code = code; }
}
function response(data, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}
function decode(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encoding');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=')), c => c.charCodeAt(0));
}
export async function verifyOperationsRequest(request, { now = Date.now, publicKey = OPERATIONS_PUBLIC_KEY } = {}) {
  const auth = request.headers.get('authorization') || '';
  if (auth.length > 8192 || !auth.startsWith('Amado-Signature ')) throw new ReadError('Acceso no autorizado.', 401);
  try {
    const parts = auth.slice(16).split('.');
    if (parts.length !== 2) throw new Error('Invalid envelope');
    const [encoded, signature] = parts;
    const key = await crypto.subtle.importKey('jwk', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(signature), encoder.encode(encoded))) throw new Error('Invalid signature');
    const payload = JSON.parse(new TextDecoder().decode(decode(encoded)));
    const seconds = Math.floor(now() / 1000);
    if (payload.v !== 1 || payload.iss !== OPERATIONS_ISSUER || payload.aud !== 'amado-mercadolibre-read' || payload.method !== 'POST' || payload.path !== OPERATIONS_PATH || payload.seller_id !== SELLER_ID || !Number.isInteger(payload.iat) || !Number.isInteger(payload.exp) || payload.exp <= seconds || payload.iat > seconds + 15 || payload.exp - payload.iat > 60 || payload.exp <= payload.iat || !/^[a-f0-9-]{36}$/.test(payload.jti)) throw new Error('Invalid claims');
    return payload;
  } catch { throw new ReadError('Acceso no autorizado o solicitud vencida.', 401); }
}

function argsObject(args, fields) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key))) throw new ReadError('Argumentos no válidos.', 400);
}
function numberOrNull(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function stringOrNull(value) { return typeof value === 'string' ? value : null; }
function projectItem(raw) {
  const attributes = Array.isArray(raw.attributes) ? raw.attributes : [];
  const attribute = id => attributes.find(a => a.id === id)?.value_name ?? null;
  return {
    id: raw.id, seller_id: raw.seller_id, title: stringOrNull(raw.title),
    price: numberOrNull(raw.price), currency_id: stringOrNull(raw.currency_id),
    status: stringOrNull(raw.status), available_quantity: numberOrNull(raw.available_quantity),
    sold_quantity: numberOrNull(raw.sold_quantity), condition: stringOrNull(raw.condition),
    permalink: stringOrNull(raw.permalink), last_updated: stringOrNull(raw.last_updated),
    catalog_listing: typeof raw.catalog_listing === 'boolean' ? raw.catalog_listing : null,
    catalog_product_id: stringOrNull(raw.catalog_product_id), user_product_id: stringOrNull(raw.user_product_id),
    isbn: attribute('ISBN') || attribute('GTIN'), author: attribute('BOOK_AUTHOR'), publisher: attribute('PUBLISHER'),
    sale_terms: (Array.isArray(raw.sale_terms) ? raw.sale_terms : []).filter(x => ['MANUFACTURING_TIME', 'WARRANTY_TYPE', 'WARRANTY_TIME'].includes(x.id)).map(x => ({ id: x.id, value_name: x.value_name })),
  };
}

export function createOperationsReader({ fetcher = (...args) => globalThis.fetch(...args), tokenProvider = getAccessToken, now = Date.now, publicKey = OPERATIONS_PUBLIC_KEY } = {}) {
  let tokenCache = null;
  let pendingToken = null;
  async function token(env) {
    if (tokenCache && now() < tokenCache.expires) return tokenCache.value;
    if (!pendingToken) pendingToken = tokenProvider(env).then(value => {
      if (typeof value !== 'string' || !value) throw new Error('No token');
      tokenCache = { value, expires: now() + 180_000 };
      return value;
    }).finally(() => { pendingToken = null; });
    return pendingToken;
  }
  async function ml(path, accessToken) {
    let res;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try { res = await fetcher(ML_ORIGIN + path, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }, redirect: 'manual', signal: controller.signal }); }
    catch (error) {
      const text = String(error?.message ?? '');
      const kind = error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'ml_timeout'
        : /redirect/i.test(text) ? 'transport_redirect_error'
        : /illegal invocation|incorrect this/i.test(text) ? 'transport_receiver_error'
        : /AbortSignal|signal.*not|timeout.*not/i.test(text) ? 'transport_signal_error'
        : /different request|I\/O/i.test(text) ? 'transport_request_context_error'
        : error?.name === 'TypeError' ? 'transport_type_error' : 'transport_network_error';
      throw new ReadError('No se pudo completar la conexión de lectura con Mercado Libre. Reintentá la consulta.', 502, kind);
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      if (res.status === 401) tokenCache = null;
      throw new ReadError(`Mercado Libre respondió HTTP ${res.status}. No se pudo confirmar la consulta.`, res.status === 429 ? 429 : 502);
    }
    try { return await res.json(); } catch { throw new ReadError('Mercado Libre devolvió una respuesta inesperada.'); }
  }
  return async function handle(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== OPERATIONS_PATH) return response({ error: 'Ruta no disponible.' }, 405);
    try {
      const payload = await verifyOperationsRequest(request, { now, publicKey });
      if (String(env.USER_ID) !== SELLER_ID || String(env.APP_ID) !== APP_ID) throw new ReadError('La aplicación no está configurada para la cuenta de Amado.', 503);
      const args = payload.args ?? {};
      if (!['cuenta', 'listar_publicaciones', 'consultar_publicaciones'].includes(payload.action)) throw new ReadError('Operación no admitida.', 400);
      // Validate every argument before any token refresh or external request.
      if (payload.action === 'cuenta') argsObject(args, []);
      if (payload.action === 'listar_publicaciones') {
        argsObject(args, ['estado', 'limite', 'scroll_id']);
        if (!['active', 'paused', 'closed', 'under_review'].includes(args.estado ?? 'active') || !Number.isInteger(args.limite ?? 20) || (args.limite ?? 20) < 1 || (args.limite ?? 20) > 20 || (args.scroll_id !== undefined && (typeof args.scroll_id !== 'string' || args.scroll_id.length < 1 || args.scroll_id.length > 2048))) throw new ReadError('Filtro de publicaciones no válido.', 400);
      }
      if (payload.action === 'consultar_publicaciones') {
        argsObject(args, ['ids']);
        if (!Array.isArray(args.ids) || args.ids.length < 1 || args.ids.length > 20 || args.ids.some(id => typeof id !== 'string' || !/^MLU\d{6,15}$/.test(id))) throw new ReadError('Indicá entre 1 y 20 identificadores MLU válidos.', 400);
      }
      let accessToken;
      try { accessToken = await token(env); } catch { throw new ReadError('No se pudo renovar la autorización existente de Mercado Libre. Es necesaria una revisión de la conexión.', 503); }
      let data;
      if (payload.action === 'cuenta') {
        const raw = await ml('/users/me', accessToken);
        if (String(raw.id) !== SELLER_ID) throw new ReadError('La autorización corresponde a una cuenta diferente de Amado.', 403);
        data = { id: raw.id, nickname: stringOrNull(raw.nickname), site_id: stringOrNull(raw.site_id), country_id: stringOrNull(raw.country_id), seller_reputation: raw.seller_reputation ?? null };
      } else if (payload.action === 'listar_publicaciones') {
        const query = new URLSearchParams({ search_type: 'scan', status: args.estado ?? 'active', limit: String(args.limite ?? 20) });
        if (args.scroll_id) query.set('scroll_id', args.scroll_id);
        const raw = await ml(`/users/${SELLER_ID}/items/search?${query}`, accessToken);
        if (!Array.isArray(raw.results) || raw.results.some(id => typeof id !== 'string' || !/^MLU\d+$/.test(id)) || (raw.seller_id !== undefined && String(raw.seller_id) !== SELLER_ID)) throw new ReadError('Mercado Libre devolvió un listado inesperado.');
        data = { estado_solicitado: args.estado ?? 'active', total: numberOrNull(raw.paging?.total), ids: raw.results, scroll_id: stringOrNull(raw.scroll_id), page_empty: raw.results.length === 0, note: 'Este es un lote de resultados. Una búsqueda incompleta no prueba la ausencia de un ISBN. El scroll debe continuarse hasta terminar.' };
      } else {
        const ids = [...new Set(args.ids)];
        const raw = await ml('/items?ids=' + ids.join(','), accessToken);
        if (!Array.isArray(raw) || raw.length !== ids.length) throw new ReadError('Mercado Libre devolvió un lote incompleto.');
        const valid = new Set(ids);
        const returned = new Set();
        data = { items: raw.map((entry, index) => {
          const httpStatus = entry.code ?? entry.status_code;
          if (httpStatus !== 200) return { id: ids[index], error: 'No se pudo consultar esta publicación.', http_status: numberOrNull(httpStatus) };
          const body = entry.body;
          if (!body || !valid.has(body.id) || returned.has(body.id) || String(body.seller_id) !== SELLER_ID) throw new ReadError('La respuesta incluye una publicación ajena o no solicitada.', 403);
          returned.add(body.id);
          return projectItem(body);
        }), catalog_note: 'catalog_listing identifica Catálogo. Un user_product_id, una URL /up/ o catalog_product_id por sí solos no lo determinan.' };
      }
      return response({ source: 'Mercado Libre API', seller_id: SELLER_ID, app_id: APP_ID, action: payload.action, queried_at: new Date(now()).toISOString(), read_only: true, data });
    } catch (error) {
      return response({ error: error instanceof ReadError ? error.message : 'No se pudo completar la consulta de Mercado Libre.', error_code: error instanceof ReadError ? error.code : 'internal_error' }, error instanceof ReadError ? error.status : 502);
    }
  };
}

export const handleOperationsRead = createOperationsReader();
