import {
  CAMPOS_PERFIL,
  COOKIE_CSRF,
  COOKIE_SESION,
  MAX_BODY_BYTES,
  NONCE_TTL_MINUTES,
  SESSION_TTL_DAYS,
  cookieDeBorrado,
  construirCookie,
  estaVencido,
  generarSecreto,
  hashSecreto,
  leerCookie,
  normalizarPerfil,
  pareceSecreto,
  perfilPublico,
  validarClaims,
  vencimiento,
} from './_cuenta_logic.js';

// Verificación del ID token contra el propio Google. Se elige este camino en
// lugar de validar la firma acá porque el proyecto no tiene ninguna
// dependencia npm en Functions y el encargo pide explícitamente NO escribir
// criptografía JWT propia. Google verifica firma y vencimiento; las demás
// comprobaciones (audiencia, emisor, nonce, correo verificado) se hacen en
// validarClaims(). Queda inyectable para poder cambiarlo por validación local
// con JWKS sin tocar el resto.
const TOKENINFO = 'https://oauth2.googleapis.com/tokeninfo?id_token=';

async function verificarConGoogle(idToken, fetchFn = fetch) {
  const controlador = new AbortController();
  const temporizador = setTimeout(() => controlador.abort(), 8_000);
  try {
    const respuesta = await fetchFn(`${TOKENINFO}${encodeURIComponent(idToken)}`, {
      signal: controlador.signal,
    });
    if (!respuesta.ok) return null;
    return await respuesta.json();
  } catch {
    return null;
  } finally {
    clearTimeout(temporizador);
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store', ...extraHeaders },
  });
}

async function leerCuerpo(request) {
  const tipo = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!tipo.includes('application/json')) return { error: json({ error: 'Content-Type debe ser application/json.' }, 415) };
  try {
    const texto = await request.text();
    if (new TextEncoder().encode(texto).byteLength > MAX_BODY_BYTES) return { error: json({ error: 'Body demasiado grande.' }, 413) };
    return { body: JSON.parse(texto) };
  } catch {
    return { error: json({ error: 'JSON inválido.' }, 400) };
  }
}

function clientId(env) {
  return String(env?.GOOGLE_CLIENT_ID || '').trim();
}

// Sin Client ID no hay login: se responde "no configurado" y el frontend
// esconde el botón. Nunca se simula un ingreso exitoso.
function sinConfigurar() {
  return json({ error: 'Ingreso con Google no configurado.', code: 'google_no_configurado' }, 503);
}

async function resolverSesion(request, db, ahora) {
  const secreto = leerCookie(request.headers.get('Cookie'), COOKIE_SESION);
  if (!secreto) return { ok: false, motivo: 'sin_cookie' };
  const hash = await hashSecreto(secreto);
  const fila = await db.prepare(
    'SELECT s.session_hash, s.identity_id, s.csrf_hash, s.expires_at, s.revoked_at, i.email ' +
    'FROM account_sessions s JOIN account_identities i ON i.id = s.identity_id ' +
    'WHERE s.session_hash = ?',
  ).bind(hash).first();
  if (!fila) return { ok: false, motivo: 'inexistente' };
  if (fila.revoked_at) return { ok: false, motivo: 'revocada', hash };
  if (estaVencido(fila.expires_at, ahora)) return { ok: false, motivo: 'vencida', hash };
  return { ok: true, hash, identityId: fila.identity_id, email: fila.email, csrfHash: fila.csrf_hash };
}

// Doble envío: la cookie CSRF la lee el JS del sitio y la repite en la
// cabecera. Un formulario de otro sitio no puede leerla, así que no puede
// mandarla. Se compara contra el hash guardado con la sesión.
async function csrfValido(request, sesion) {
  const enviado = String(request.headers.get('X-CSRF-Token') || '').trim();
  if (!pareceSecreto(enviado)) return false;
  return (await hashSecreto(enviado)) === sesion.csrfHash;
}

// ─── GET /api/cuenta/nonce ───────────────────────────────────────────────────

export function crearNonceHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET' });
    if (!clientId(env)) return sinConfigurar();
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);

    const ahora = getNow();
    const nonce = generarSecreto();
    await db.prepare('INSERT INTO auth_nonces (nonce_hash, created_at, expires_at) VALUES (?, ?, ?)')
      .bind(await hashSecreto(nonce), ahora.toISOString(), vencimiento(ahora, NONCE_TTL_MINUTES).toISOString())
      .run();
    return json({ nonce });
  };
}

// ─── POST /api/cuenta/google ─────────────────────────────────────────────────

export function crearGoogleHandler({
  getNow = () => new Date(),
  verificarToken = verificarConGoogle,
  fetchFn = fetch,
} = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    const idCliente = clientId(env);
    if (!idCliente) return sinConfigurar();
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);

    const { body, error } = await leerCuerpo(request);
    if (error) return error;

    const credencial = typeof body?.credential === 'string' ? body.credential.trim() : '';
    const nonce = typeof body?.nonce === 'string' ? body.nonce.trim() : '';
    if (!credencial || !pareceSecreto(nonce)) return json({ error: 'Ingreso inválido.' }, 400);

    const ahora = getNow();
    const ahoraIso = ahora.toISOString();

    // El nonce se consume en la condición del UPDATE: si dos peticiones traen
    // el mismo, sólo una cambia la fila. Mirar y después escribir dejaría una
    // ventana para reusar el token.
    const consumo = await db.prepare(
      'UPDATE auth_nonces SET used_at = ? WHERE nonce_hash = ? AND used_at IS NULL AND expires_at > ?',
    ).bind(ahoraIso, await hashSecreto(nonce), ahoraIso).run();
    if (consumo?.meta?.changes !== 1) return json({ error: 'Ingreso inválido o vencido.', motivo: 'nonce' }, 400);

    const claims = await verificarToken(credencial, fetchFn);
    const validez = validarClaims(claims, { clientId: idCliente, nonceEsperado: nonce, ahora });
    if (!validez.ok) return json({ error: 'No pudimos verificar tu ingreso.', motivo: validez.motivo }, 401);

    // Identidad por proveedor + subject. El correo se guarda como dato, no
    // como llave: dos cuentas nunca se unen por compartir un email.
    const existente = await db.prepare(
      'SELECT id FROM account_identities WHERE provider = ? AND subject = ?',
    ).bind('google', validez.subject).first();

    let identityId = existente?.id || null;
    if (identityId) {
      await db.prepare('UPDATE account_identities SET email = ?, last_seen_at = ? WHERE id = ?')
        .bind(validez.email, ahoraIso, identityId).run();
    } else {
      identityId = generarSecreto();
      await db.prepare(
        'INSERT INTO account_identities (id, provider, subject, email, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(identityId, 'google', validez.subject, validez.email, ahoraIso, ahoraIso).run();
    }

    const sesion = generarSecreto();
    const csrf = generarSecreto();
    const vence = vencimiento(ahora, SESSION_TTL_DAYS * 24 * 60);
    await db.prepare(
      'INSERT INTO account_sessions (session_hash, identity_id, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).bind(await hashSecreto(sesion), identityId, await hashSecreto(csrf), ahoraIso, vence.toISOString()).run();

    const perfil = await db.prepare(
      `SELECT ${CAMPOS_PERFIL.join(', ')} FROM account_profiles WHERE identity_id = ?`,
    ).bind(identityId).first();

    const maxAge = SESSION_TTL_DAYS * 24 * 60 * 60;
    const headers = new Headers({ 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', construirCookie(COOKIE_SESION, sesion, { maxAgeSegundos: maxAge }));
    headers.append('Set-Cookie', construirCookie(COOKIE_CSRF, csrf, { maxAgeSegundos: maxAge, httpOnly: false }));

    return new Response(JSON.stringify({
      autenticado: true,
      email: validez.email,
      // Google básico puede aportar el nombre. El teléfono y la dirección NO
      // vienen de Google: salen del navegador o los escribe la persona.
      nombre_sugerido: validez.nombre,
      tiene_perfil: Boolean(perfil),
    }), { status: 200, headers });
  };
}

// ─── GET /api/cuenta/sesion ──────────────────────────────────────────────────

export function crearSesionHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'GET') return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET' });
    const db = env?.ORDERS_DB;
    if (!db) return json({ autenticado: false });
    const sesion = await resolverSesion(request, db, getNow());
    if (!sesion.ok) return json({ autenticado: false });
    const perfil = await db.prepare('SELECT identity_id FROM account_profiles WHERE identity_id = ?')
      .bind(sesion.identityId).first();
    return json({ autenticado: true, email: sesion.email, tiene_perfil: Boolean(perfil) });
  };
}

// ─── /api/cuenta/perfil ──────────────────────────────────────────────────────

export function crearPerfilHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET, POST' });
    }

    const sesion = await resolverSesion(request, db, getNow());
    if (!sesion.ok) return json({ error: 'No autenticado.' }, 401);

    if (request.method === 'GET') {
      // La consulta se ata a la identidad de la SESIÓN. Si el identity_id
      // viniera de la petición, cualquiera leería el perfil ajeno.
      const fila = await db.prepare(
        `SELECT ${CAMPOS_PERFIL.join(', ')} FROM account_profiles WHERE identity_id = ?`,
      ).bind(sesion.identityId).first();
      return json({ perfil: perfilPublico(fila) });
    }

    if (!(await csrfValido(request, sesion))) return json({ error: 'Verificación CSRF fallida.' }, 403);

    const { body, error } = await leerCuerpo(request);
    if (error) return error;

    const { perfil, error: errorPerfil } = normalizarPerfil(body?.perfil);
    if (errorPerfil) return json({ error: errorPerfil }, 400);

    const ahoraIso = getNow().toISOString();
    // Guardar el perfil NO crea ni modifica ningún pedido: escribe una sola
    // fila en su propia tabla.
    await db.prepare(
      'INSERT INTO account_profiles (identity_id, buyer_name, buyer_phone, address, locality, department, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(identity_id) DO UPDATE SET ' +
      'buyer_name = excluded.buyer_name, buyer_phone = excluded.buyer_phone, address = excluded.address, ' +
      'locality = excluded.locality, department = excluded.department, updated_at = excluded.updated_at',
    ).bind(
      sesion.identityId, perfil.buyer_name, perfil.buyer_phone,
      perfil.address, perfil.locality, perfil.department, ahoraIso,
    ).run();

    return json({ ok: true, perfil });
  };
}

// ─── POST /api/cuenta/salir ──────────────────────────────────────────────────

export function crearSalidaHandler({ getNow = () => new Date() } = {}) {
  return async function onRequest({ request, env }) {
    if (request.method !== 'POST') return json({ error: 'Método no permitido.' }, 405, { Allow: 'POST' });
    const db = env?.ORDERS_DB;
    if (!db) return json({ error: 'Servicio no disponible.' }, 503);

    const sesion = await resolverSesion(request, db, getNow());
    if (sesion.ok && !(await csrfValido(request, sesion))) {
      return json({ error: 'Verificación CSRF fallida.' }, 403);
    }
    if (sesion.hash) {
      await db.prepare('UPDATE account_sessions SET revoked_at = ? WHERE session_hash = ? AND revoked_at IS NULL')
        .bind(getNow().toISOString(), sesion.hash).run();
    }

    // Las cookies se borran siempre: salir nunca deja al navegador con una
    // credencial en la mano.
    const headers = new Headers({ 'Content-Type': 'application/json;charset=UTF-8', 'Cache-Control': 'no-store' });
    headers.append('Set-Cookie', cookieDeBorrado(COOKIE_SESION));
    headers.append('Set-Cookie', cookieDeBorrado(COOKIE_CSRF, { httpOnly: false }));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  };
}
