import { deriveSessionSecret, hasValidSession, parseCookies, resolvePanelConfig } from './panel-auth.js';

export const APP_ID = '4741021817925208';
export const CALLBACK = 'https://www.amadolibros.com/meli-vintage-callback';
const ORIGIN = new URL(CALLBACK).origin;
const START_PATH = '/panel/meli-vintage';
const COOKIE = '__Secure-amado_meli_vintage';
const TTL = 10 * 60 * 1000;
// Intentionally separate from ml_oauth and auth:refresh_token. Existing consumers
// of the Libros grant must never discover or select the Vintage grant implicitly.
export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ml_oauth_vintage_states (state_hash TEXT PRIMARY KEY,browser_hash TEXT NOT NULL,verifier TEXT NOT NULL,expected_email TEXT NOT NULL,expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ml_oauth_sellers (app_id TEXT NOT NULL,seller_id TEXT NOT NULL,nickname TEXT NOT NULL,access_token TEXT NOT NULL,access_expires_at INTEGER NOT NULL,refresh_token TEXT NOT NULL,authorized_at INTEGER NOT NULL,PRIMARY KEY(app_id,seller_id))`,
];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const base64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hash = async text => base64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const random = () => base64(crypto.getRandomValues(new Uint8Array(32)));
const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/meli-vintage-callback; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
const SAFE_ERRORS = new Set(['invalid_client', 'invalid_grant', 'invalid_request', 'invalid_scope', 'unsupported_grant_type', 'local_rate_limited']);
class UpstreamFailure extends Error {
  constructor(status, code) { super('upstream_rejected'); this.status = status; this.safeCode = SAFE_ERRORS.has(code) ? code : 'upstream_rejected'; }
}

function page(title, body, status = 200, extraHeaders = {}) {
  return new Response(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:18px system-ui;max-width:640px;margin:10vh auto;padding:24px;line-height:1.6}input,button{font:inherit;padding:10px;margin:12px 0}button{cursor:pointer}code{overflow-wrap:anywhere}</style><h1>${escape(title)}</h1>${body}</html>`, {
    status, headers: { 'Content-Type': 'text/html;charset=UTF-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.mercadolibre.com.uy; frame-ancestors 'none'; base-uri 'none'", ...extraHeaders },
  });
}

export function createVintageOAuth({ fetcher = (...args) => fetch(...args), now = Date.now } = {}) {
  const statement = (db, sql, ...args) => db.prepare(sql).bind(...args);
  async function schema(db) { await db.batch(SCHEMA.map(sql => db.prepare(sql))); }
  async function json(url, options) {
    const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      let data; try { data = await response.json(); } catch { data = null; }
      throw new UpstreamFailure(response.status, data?.error);
    }
    return response.json();
  }
  return async function onRequest({ request, env }) {
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || env?.APP_ENV !== 'production') return page('No disponible', '<p>Esta conexión se realiza desde la web principal de Amado.</p>', 403);
    if (![START_PATH, '/meli-vintage-callback'].includes(url.pathname)) return page('No encontrado', '', 404);
    if (!['GET', 'POST'].includes(request.method) || (url.pathname === '/meli-vintage-callback' && request.method !== 'GET')) return page('Método no permitido', '', 405);
    const db = env?.ORDERS_DB;
    if (!db?.prepare || !env?.CLIENT_SECRET || (env.APP_ID && String(env.APP_ID) !== APP_ID)) return page('Conexión pendiente de configuración', '<p>Falta configurar el acceso de la app en el servidor. No se modificó ninguna autorización.</p>', 503);
    if (url.pathname === START_PATH) {
      const panel = resolvePanelConfig(env);
      if (!panel.ok || !await hasValidSession(request, await deriveSessionSecret(panel.password))) return page('Ingresá al panel de Amado', `<p><a href="/panel">Abrir el panel</a>. Después volvé a esta página en la misma ventana de Chrome donde está abierta Amado Vintage.</p>`, 401);
      if (request.method === 'GET' && url.searchParams.get('diagnostico') === '1') {
        // Use an intentionally invalid code: this cannot authorize a seller,
        // refresh a grant, or create tokens. Never reuse the user's real code.
        let result = 'El servidor no pudo obtener una respuesta.';
        try {
          await json('https://api.mercadolibre.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: APP_ID, client_secret: env.CLIENT_SECRET, redirect_uri: CALLBACK, code: 'amado-vintage-diagnostic-deliberately-invalid-code', code_verifier: 'amado-vintage-diagnostic-invalid-code-verifier-43-characters' }) });
          result = 'Respuesta inesperada: detener la conexión y revisar el servidor.';
        } catch (error) {
          if (error instanceof UpstreamFailure) result = `HTTP ${error.status} · ${error.safeCode}`;
        }
        return page('Diagnóstico de conexión', `<p>Respuesta del servicio de autorización: <strong>${escape(result)}</strong>.</p><p>Se utilizó un código de prueba inválido. No se autorizó ninguna cuenta ni se renovaron credenciales.</p><p>Este resultado por sí solo no confirma que la clave sea correcta. Compartí este mensaje para revisar el siguiente paso.</p>`);
      }
      // no-referrer makes browsers send Origin: null on a native form POST.
      // Keep the exact Origin check below; allow origin only within this site.
      if (request.method === 'GET') return page('Conectar Amado Vintage', `<p>Antes de continuar, comprobá que Mercado Libre muestre <strong>AMADO VINTAGE</strong>. Si muestra AMADOLIBROS COMUY, detenete.</p><p>Se conservará la conexión de Amado Libros. Este proceso no modifica publicaciones.</p><form method="post" action="${START_PATH}"><label>Correo de la cuenta Amado Vintage<br><input name="email" type="email" maxlength="254" required autocomplete="email"></label><br><button>Continuar a Mercado Libre</button></form>`, 200, { 'Referrer-Policy': 'same-origin' });
      if (request.headers.get('origin') !== ORIGIN || !request.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded')) return page('Solicitud inválida', '', 403);
      if (Number(request.headers.get('content-length')) > 2048) return page('Solicitud inválida', '', 413);
      const rawBody = await request.text();
      if (rawBody.length > 2048) return page('Solicitud inválida', '', 413);
      const email = (new URLSearchParams(rawBody).get('email') || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return page('Correo inválido', '<p>Ingresá el correo de la cuenta Amado Vintage.</p>', 400);
      try {
        await schema(db);
        const state = random(), browser = random(), verifier = random();
        await statement(db, 'DELETE FROM ml_oauth_vintage_states WHERE expires_at<=?', now()).run();
        await statement(db, 'INSERT INTO ml_oauth_vintage_states(state_hash,browser_hash,verifier,expected_email,expires_at) VALUES(?,?,?,?,?)', await hash(state), await hash(browser), verifier, email, now() + TTL).run();
        const authorization = new URL('https://auth.mercadolibre.com.uy/authorization');
        authorization.search = new URLSearchParams({ response_type: 'code', client_id: APP_ID, redirect_uri: CALLBACK, state, code_challenge: await hash(verifier), code_challenge_method: 'S256' });
        return page('Continuar a Mercado Libre', '', 303, { Location: authorization.toString(), 'Set-Cookie': cookie(browser, TTL / 1000) });
      } catch { return page('No se pudo iniciar la conexión', '<p>Volvé a intentar desde esta página.</p>', 503); }
    }
    // A plain visit is informational: no API calls, schema writes or token refresh.
    if (!url.search) return page('Conexión de Amado Vintage', `<p>La recepción de la autorización está disponible.</p><p><a href="${START_PATH}">Iniciar desde el panel de Amado</a></p>`);
    const state = url.searchParams.get('state') || '';
    const browser = parseCookies(request.headers.get('cookie')).get(COOKIE) || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(browser)) return page('Autorización no válida', '<p>Iniciá nuevamente desde el panel. No se guardó ninguna credencial.</p>', 400);
    let stage = 'schema';
    try {
      await schema(db);
      stage = 'state_claim';
      // Atomic, single-use claim; bound to this browser, with an expiry.
      const pending = await statement(db, 'DELETE FROM ml_oauth_vintage_states WHERE state_hash=? AND browser_hash=? AND expires_at>? RETURNING verifier,expected_email', await hash(state), await hash(browser), now()).first();
      if (!pending) return page('Autorización vencida o utilizada', '<p>Iniciá nuevamente desde el panel.</p>', 400);
      const headers = { 'Set-Cookie': cookie('', 0) };
      const code = url.searchParams.get('code');
      if (url.searchParams.has('error') || !code || code.length > 2048) return page('Autorización cancelada', '<p>No se guardó ninguna credencial.</p>', 400, headers);
      stage = 'token_exchange';
      const tokens = await json('https://api.mercadolibre.com/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: APP_ID, client_secret: env.CLIENT_SECRET, redirect_uri: CALLBACK, code, code_verifier: pending.verifier }) });
      stage = 'token_payload';
      if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0) throw new Error('invalid_tokens');
      stage = 'user_identity';
      const user = await json('https://api.mercadolibre.com/users/me', { method: 'GET', headers: { Authorization: `Bearer ${tokens.access_token}`, Accept: 'application/json' } });
      const seller = String(user.id || '');
      const nickname = String(user.nickname || '');
      const normalized = nickname.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (seller === '440298103' || normalized === 'AMADOLIBROSCOMUY') return page('Cuenta Amado Libros detectada', '<p>Proceso detenido. No se guardó ni reemplazó ninguna credencial.</p>', 409, headers);
      if (!/^\d+$/.test(seller) || user.site_id !== 'MLU' || seller !== String(tokens.user_id) || String(user.email || '').toLowerCase() !== pending.expected_email) return page('La cuenta no coincide', '<p>La cuenta autorizada no coincide con el correo indicado para Amado Vintage. No se guardó ninguna credencial.</p>', 409, headers);
      // INSERT only: even an existing seller grant is never overwritten here.
      stage = 'credential_save';
      const inserted = await statement(db, 'INSERT OR IGNORE INTO ml_oauth_sellers(app_id,seller_id,nickname,access_token,access_expires_at,refresh_token,authorized_at) VALUES(?,?,?,?,?,?,?) RETURNING seller_id', APP_ID, seller, nickname, tokens.access_token, now() + Number(tokens.expires_in) * 1000, tokens.refresh_token, now()).first();
      if (!inserted) return page('La cuenta ya tiene una autorización guardada', '<p>No se reemplazaron sus credenciales. Revisá la conexión existente antes de volver a autorizar.</p>', 409, headers);
      return page('Amado Vintage conectada', `<p>Cuenta verificada mediante <code>GET /users/me</code>: <strong>${escape(nickname)}</strong>.</p><p>seller_id: <strong>${escape(seller)}</strong></p><p>La autorización se guardó por app y seller, separada de Amado Libros. No se modificaron publicaciones.</p>`, 200, headers);
    } catch (error) {
      const reason = error instanceof UpstreamFailure ? `HTTP ${error.status} · ${error.safeCode}` : 'server_error';
      // Do not print exception messages, request URLs, codes, state, or tokens.
      console.warn(JSON.stringify({ event: 'meli_vintage_oauth_failed', stage, reason }));
      return page('No se pudo completar la conexión', `<p>La conexión no quedó confirmada. No se reemplazaron credenciales existentes.</p><p>Diagnóstico: <strong>${escape(stage)} · ${escape(reason)}</strong>.</p><p>Revisá el servidor antes de volver a autorizar.</p>`, 503, { 'Set-Cookie': cookie('', 0) });
    }
  };
}
