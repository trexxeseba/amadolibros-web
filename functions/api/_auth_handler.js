import {
  COOKIE_NAME,
  MAX_BODY_BYTES,
  RATE_LIMITS,
  SESSION_TTL_DAYS,
  TOKEN_TTL_MINUTES,
  construirCookie,
  construirCorreoDeIngreso,
  construirEnlace,
  cookieDeBorrado,
  generarSecreto,
  hashSecreto,
  leerCookieDeSesion,
  normalizeEmail,
  pareceSecreto,
  pedidoPublico,
  sesionUtilizable,
  superaLimite,
  tokenUtilizable,
  vencimiento,
} from './_auth_logic.js';
import { verifyTurnstile } from './_turnstile.js';
import { resolveConfig } from './_env_config.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

// La respuesta de "pedí un enlace" es SIEMPRE la misma, exista o no ese
// correo. Si variara, el endpoint diría quién compró en la librería.
function respuestaUniforme() {
  return json({ ok: true, mensaje: 'Si ese correo tiene pedidos, te mandamos un enlace para entrar.' });
}

async function leerCuerpo(request) {
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.includes('application/json')) return { error: json({ error: 'Content-Type debe ser application/json.' }, 415) };
  const declarado = Number.parseInt(request.headers.get('Content-Length') || '0', 10);
  if (Number.isFinite(declarado) && declarado > MAX_BODY_BYTES) return { error: json({ error: 'Body demasiado grande.' }, 413) };
  try {
    const texto = await request.text();
    if (new TextEncoder().encode(texto).byteLength > MAX_BODY_BYTES) return { error: json({ error: 'Body demasiado grande.' }, 413) };
    return { body: JSON.parse(texto) };
  } catch {
    return { error: json({ error: 'JSON inválido.' }, 400) };
  }
}

// Sin KV no hay límite de envío, y sin límite este endpoint manda correo a
// cualquier dirección sin tope. Se falla cerrado a propósito.
async function dentroDelLimite(kv, clave, limite, ahora) {
  const bruto = await kv.get(clave);
  const cuenta = Number.parseInt(bruto || '0', 10);
  if (superaLimite(cuenta, limite)) return false;
  await kv.put(clave, String((Number.isFinite(cuenta) ? cuenta : 0) + 1), {
    expirationTtl: limite.ventanaSegundos,
  });
  return true;
}

async function enviarPorResend({ env, to, email, fetchFn }) {
  const apiKey = String(env?.RESEND_API_KEY || '').trim();
  const from = String(env?.SALES_NOTIFICATION_FROM || '').trim();
  if (!apiKey || !from) return { ok: false, code: 'EMAIL_CONFIG_MISSING' };
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 10_000);
  try {
    const respuesta = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], ...email }),
      signal: controlador.signal,
    });
    return respuesta.ok ? { ok: true } : { ok: false, code: `RESEND_HTTP_${respuesta.status}` };
  } catch {
    return { ok: false, code: 'RESEND_ERROR' };
  } finally {
    clearTimeout(temporizador);
  }
}

function ipDe(request) {
  return String(request.headers.get('CF-Connecting-IP') || '').slice(0, 64);
}

// ─── POST /api/auth/solicitar ────────────────────────────────────────────────

export function crearSolicitudHandler({
  getNow = () => new Date(),
  verifyTurnstileToken = verifyTurnstile,
  fetchFn = fetch,
  enviarCorreo = enviarPorResend,
} = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });

    const config = resolveConfig(env);
    if (!config.ok) return json({ error: 'Servicio no disponible.' }, 503);

    const db = env?.ORDERS_DB;
    const kv = env?.AMADO_KV;
    const turnstileSecret = String(env?.TURNSTILE_SECRET_KEY || '').trim();
    if (!db || !kv || !turnstileSecret) return json({ error: 'Servicio no disponible.' }, 503);

    const { body, error } = await leerCuerpo(request);
    if (error) return error;

    const email = normalizeEmail(body?.email);
    const turnstileToken = typeof body?.turnstileToken === 'string' ? body.turnstileToken : '';
    if (!email || !turnstileToken) return json({ error: 'Correo o verificación faltante.' }, 400);

    const ip = ipDe(request);
    const verificacion = await verifyTurnstileToken(turnstileToken, turnstileSecret, ip, {
      expectedHostname: config.isExpectedTurnstileHostname,
    });
    if (!verificacion?.ok) return json({ error: 'Verificación fallida.' }, 403);

    const ahora = getNow();
    const permitidoPorCorreo = await dentroDelLimite(kv, `login:correo:${email}`, RATE_LIMITS.porCorreo, ahora);
    const permitidoPorIp = ip ? await dentroDelLimite(kv, `login:ip:${ip}`, RATE_LIMITS.porIp, ahora) : true;
    // Se responde igual que en el caso normal: decir "te pasaste del límite"
    // confirmaría que ese correo existe.
    if (!permitidoPorCorreo || !permitidoPorIp) return respuestaUniforme();

    // Sólo se manda el enlace si ese correo tiene al menos un pedido. Un
    // correo sin pedidos no recibe nada, y aun así la respuesta es idéntica.
    const tienePedidos = await db.prepare(
      'SELECT 1 AS existe FROM orders WHERE buyer_email = ? LIMIT 1',
    ).bind(email).first();
    if (!tienePedidos) return respuestaUniforme();

    const secreto = generarSecreto();
    const hash = await hashSecreto(secreto);
    await db.prepare(
      'INSERT INTO auth_tokens (token_hash, email, created_at, expires_at, request_ip) VALUES (?, ?, ?, ?, ?)',
    ).bind(hash, email, ahora.toISOString(), vencimiento(ahora, TOKEN_TTL_MINUTES).toISOString(), ip || null).run();

    await enviarCorreo({
      env,
      to: email,
      email: construirCorreoDeIngreso({ enlace: construirEnlace(config.canonicalOrigin, secreto) }),
      fetchFn,
    });

    return respuestaUniforme();
  };
}

// ─── POST /api/auth/confirmar ────────────────────────────────────────────────
//
// Es POST y no GET a propósito. Los clientes de correo y los antivirus abren
// los enlaces por su cuenta para inspeccionarlos; si el token se consumiera
// con un GET, el escaneo lo quemaría antes de que el comprador lo tocara.

export function crearConfirmacionHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });

    const config = resolveConfig(env);
    if (!config.ok) return json({ error: 'Servicio no disponible.' }, 503);
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);

    const { body, error } = await leerCuerpo(request);
    if (error) return error;

    const secreto = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!pareceSecreto(secreto)) return json({ error: 'Enlace inválido o vencido.' }, 400);

    const ahora = getNow();
    const ahoraIso = ahora.toISOString();
    const hash = await hashSecreto(secreto);

    // Un solo uso, de verdad: la condición vive en el WHERE, así que si dos
    // peticiones llegan a la vez sólo una cambia la fila. Mirar primero y
    // escribir después dejaría una ventana para usarlo dos veces.
    const consumo = await db.prepare(
      'UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?',
    ).bind(ahoraIso, hash, ahoraIso).run();

    if (consumo?.meta?.changes !== 1) {
      const fila = await db.prepare('SELECT email, expires_at, used_at FROM auth_tokens WHERE token_hash = ?')
        .bind(hash).first();
      const estado = tokenUtilizable(fila, ahora);
      return json({ error: 'Enlace inválido o vencido.', motivo: estado.motivo || 'inexistente' }, 400);
    }

    const fila = await db.prepare('SELECT email FROM auth_tokens WHERE token_hash = ?').bind(hash).first();
    const email = normalizeEmail(fila?.email);
    if (!email) return json({ error: 'Enlace inválido o vencido.' }, 400);

    const sesion = generarSecreto();
    const sesionHash = await hashSecreto(sesion);
    const vence = vencimiento(ahora, SESSION_TTL_DAYS * 24 * 60);
    await db.prepare(
      'INSERT INTO auth_sessions (session_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(sesionHash, email, ahoraIso, vence.toISOString()).run();

    return json({ ok: true, email }, 200, {
      'Set-Cookie': construirCookie(sesion, { maxAgeSegundos: SESSION_TTL_DAYS * 24 * 60 * 60 }),
    });
  };
}

// ─── Sesión actual ───────────────────────────────────────────────────────────

async function resolverSesion(request, db, ahora) {
  const secreto = leerCookieDeSesion(request.headers.get('Cookie'));
  if (!secreto) return { ok: false, motivo: 'sin_cookie' };
  const hash = await hashSecreto(secreto);
  const fila = await db.prepare(
    'SELECT email, expires_at, revoked_at FROM auth_sessions WHERE session_hash = ?',
  ).bind(hash).first();
  return { ...sesionUtilizable(fila, ahora), hash };
}

export function crearSesionHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET' });
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);
    const sesion = await resolverSesion(request, db, getNow());
    if (!sesion.ok) return json({ autenticado: false });
    return json({ autenticado: true, email: sesion.email });
  };
}

export function crearSalidaHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);
    const sesion = await resolverSesion(request, db, getNow());
    // La cookie se borra siempre, aunque la sesión ya no exista: salir nunca
    // debe dejar al navegador con una credencial en la mano.
    if (sesion.hash) {
      await db.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL')
        .bind(getNow().toISOString(), sesion.hash).run();
    }
    return json({ ok: true }, 200, { 'Set-Cookie': cookieDeBorrado() });
  };
}

// ─── GET /api/mis-pedidos ────────────────────────────────────────────────────

const PEDIDOS_SELECT =
  'SELECT id, public_code, status, payment_status, delivery_type, ' +
  'payable_total_uyu, currency, created_at ' +
  'FROM orders WHERE buyer_email = ? ORDER BY created_at DESC LIMIT 50';

export function crearMisPedidosHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET' });
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);

    const sesion = await resolverSesion(request, db, getNow());
    if (!sesion.ok) return json({ error: 'No autenticado.' }, 401);

    // La consulta se ata al correo de la SESIÓN, nunca a un parámetro de la
    // petición: si el correo viniera de la URL, cualquiera leería los pedidos
    // ajenos con sólo cambiarlo.
    const pedidos = await db.prepare(PEDIDOS_SELECT).bind(sesion.email).all();
    const filas = Array.isArray(pedidos?.results) ? pedidos.results : [];

    const conArticulos = [];
    for (const fila of filas) {
      const items = await db.prepare(
        'SELECT title, quantity, unit_price_uyu, line_total_uyu FROM order_items WHERE order_id = ?',
      ).bind(fila.id).all();
      conArticulos.push(pedidoPublico(fila, Array.isArray(items?.results) ? items.results : []));
    }

    return json({ email: sesion.email, pedidos: conArticulos });
  };
}

export { COOKIE_NAME };
