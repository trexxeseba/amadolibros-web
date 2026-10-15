/**
 * worker-sync/meli-auth.js
 *
 * Única fuente de verdad del OAuth de Mercado Libre: la tabla D1 `ml_oauth`
 * (binding ORDERS_DB, compartido por el Worker de sync y las Functions de Pages).
 *
 *   - access_token con su vencimiento real (`expires_in` de la respuesta de ML);
 *     sólo se renueva cuando faltan menos de REFRESH_MARGIN_MS para vencer.
 *   - refresh_token rotativo de un solo uso: el reemplazo es un UPDATE
 *     condicionado al token exacto que se usó (compare-and-swap).
 *   - lock fuerte en D1 (UPDATE ... WHERE lock_until<ahora RETURNING): dos
 *     isolates nunca refrescan a la vez. KV no se usa como mutex.
 *   - Bootstrap: si la tabla está vacía se siembra una sola vez desde
 *     AMADO_KV auth:refresh_token (esquema anterior). Después de eso KV no se
 *     lee ni se escribe más.
 *   - Errores tipados: MeliAuthError.retryable indica si corresponde reintentar
 *     (transporte, 5xx, 429, lock ocupado) o si hace falta reautorizar
 *     (invalid_grant, sin bootstrap, sin configuración).
 */

export const OAUTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ml_oauth (app_id TEXT PRIMARY KEY,access_token TEXT,access_expires_at INTEGER NOT NULL DEFAULT 0,refresh_token TEXT NOT NULL,refresh_updated_at INTEGER NOT NULL DEFAULT 0,lock_token TEXT,lock_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_error_at INTEGER NOT NULL DEFAULT 0)`,
];
export const REFRESH_MARGIN_MS = 5 * 60 * 1000;   // renovar cuando falte menos que esto
const LOCK_TTL_MS = 30_000;                        // mayor que el timeout del POST /oauth/token
const TOKEN_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 8;
const LEGACY_KV_KEY = 'auth:refresh_token';
const schemaReady = new WeakSet();

export class MeliAuthError extends Error {
  constructor(code, { status = 503, retryable = true, retryAfter = 0 } = {}) {
    super(code); this.code = code; this.status = status; this.retryable = retryable; this.retryAfter = retryAfter;
  }
}

export function createMeliAuth({ fetcher = (...args) => globalThis.fetch(...args), now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random } = {}) {
  const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
  async function ensureSchema(db) {
    if (schemaReady.has(db)) return;
    await db.batch(OAUTH_SCHEMA.map(sql => db.prepare(sql)));
    schemaReady.add(db);
  }
  function config(env) {
    const db = env?.ORDERS_DB;
    if (!db || typeof db.prepare !== 'function') throw new MeliAuthError('auth_storage_not_configured', { status: 503, retryable: false });
    const appId = String(env.APP_ID ?? '');
    if (!/^\d{5,}$/.test(appId) || typeof env.CLIENT_SECRET !== 'string' || !env.CLIENT_SECRET) throw new MeliAuthError('auth_not_configured', { status: 503, retryable: false });
    return { db, appId };
  }
  const read = (db, appId) => stmt(db, 'SELECT * FROM ml_oauth WHERE app_id=?', appId).first();
  const usable = row => typeof row?.access_token === 'string' && row.access_token.length > 0 && Number(row.access_expires_at) - now() > REFRESH_MARGIN_MS;
  async function seed(env, db, appId) {
    // Un solo bootstrap desde el esquema anterior en KV. Nunca desde variables de entorno.
    let legacy = null;
    try { legacy = env.AMADO_KV && typeof env.AMADO_KV.get === 'function' ? await env.AMADO_KV.get(LEGACY_KV_KEY) : null; } catch { legacy = null; }
    if (typeof legacy !== 'string' || !legacy) return;
    await stmt(db, 'INSERT OR IGNORE INTO ml_oauth(app_id,refresh_token,refresh_updated_at) VALUES(?,?,?)', appId, legacy, now()).run();
  }
  async function recordError(db, appId, code) {
    await stmt(db, 'UPDATE ml_oauth SET last_error=?,last_error_at=? WHERE app_id=?', code, now(), appId).run().catch(() => {});
  }
  async function exchange(env, db, appId, usedRefresh, lockToken) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    let res, data = null;
    try {
      res = await fetcher('https://api.mercadolibre.com/oauth/token', {
        method: 'POST', redirect: 'manual', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: appId, client_secret: env.CLIENT_SECRET, refresh_token: usedRefresh }),
      });
    } catch { throw new MeliAuthError('auth_transport', { status: 503, retryable: true }); }
    finally { clearTimeout(timer); }
    try { data = await res.json(); } catch { data = null; }
    if (res.ok && typeof data?.access_token === 'string' && data.access_token) {
      const expiresIn = Number(data.expires_in);
      // Sin expires_in no se asume duración: el token sirve para esta llamada y no se cachea.
      const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? now() + expiresIn * 1000 : 0;
      const nextRefresh = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : usedRefresh;
      const swapped = await stmt(db, 'UPDATE ml_oauth SET access_token=?,access_expires_at=?,refresh_token=?,refresh_updated_at=?,last_error=NULL,last_error_at=0 WHERE app_id=? AND lock_token=? AND refresh_token=? RETURNING app_id',
        data.access_token, expiresAt, nextRefresh, now(), appId, lockToken, usedRefresh).first();
      if (!swapped) console.warn('[Auth] El refresh token cambió durante la renovación; se conserva el estado guardado.');
      return data.access_token;
    }
    const upstream = String(data?.error ?? '');
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Math.min(3600, Math.max(0, Number(res.headers?.get?.('retry-after')) || 0));
      await recordError(db, appId, `auth_upstream_${res.status}`);
      throw new MeliAuthError(`auth_upstream_${res.status}`, { status: 503, retryable: true, retryAfter });
    }
    if (upstream === 'invalid_grant' || /invalid/i.test(String(data?.message ?? ''))) {
      await recordError(db, appId, 'auth_invalid_grant');
      throw new MeliAuthError('auth_invalid_grant', { status: 401, retryable: false });
    }
    await recordError(db, appId, `auth_rejected_${res.status}`);
    throw new MeliAuthError('auth_rejected', { status: 401, retryable: false });
  }
  async function getAccessToken(env) {
    const { db, appId } = config(env);
    await ensureSchema(db);
    let lastRefreshUsed = null;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      let row = await read(db, appId);
      if (!row) { await seed(env, db, appId); row = await read(db, appId); }
      if (!row) throw new MeliAuthError('auth_not_bootstrapped', { status: 401, retryable: false });
      if (usable(row)) return row.access_token;
      if (lastRefreshUsed && row.refresh_token === lastRefreshUsed) throw new MeliAuthError('auth_invalid_grant', { status: 401, retryable: false });
      const lockToken = crypto.randomUUID();
      const locked = await stmt(db, 'UPDATE ml_oauth SET lock_token=?,lock_until=? WHERE app_id=? AND lock_until<? RETURNING access_token,access_expires_at,refresh_token', lockToken, now() + LOCK_TTL_MS, appId, now()).first();
      if (!locked) { await sleep(Math.min(3000, 250 * 2 ** attempt) + random() * 250); continue; }
      try {
        // Otro isolate pudo renovar entre la lectura y el lock: reutilizar sin refrescar.
        if (usable(locked)) return locked.access_token;
        return await exchange(env, db, appId, locked.refresh_token, lockToken);
      } catch (error) {
        // invalid_grant con un refresh token que otro proceso ya reemplazó: reintentar con el guardado.
        if (error instanceof MeliAuthError && error.code === 'auth_invalid_grant') { lastRefreshUsed = locked.refresh_token; continue; }
        throw error;
      } finally {
        await stmt(db, 'UPDATE ml_oauth SET lock_token=NULL,lock_until=0 WHERE app_id=? AND lock_token=?', appId, lockToken).run().catch(() => {});
      }
    }
    throw new MeliAuthError('auth_lock_busy', { status: 503, retryable: true });
  }
  // Un 401 de la API con el token vigente: descartarlo para que la próxima llamada renueve.
  async function invalidateAccessToken(env, accessToken) {
    const { db, appId } = config(env);
    await stmt(db, 'UPDATE ml_oauth SET access_token=NULL,access_expires_at=0 WHERE app_id=? AND access_token=?', appId, accessToken).run();
  }
  // Diagnóstico sin credenciales.
  async function state(env) {
    const { db, appId } = config(env);
    await ensureSchema(db);
    const row = await read(db, appId);
    if (!row) return { bootstrapped: false };
    return { bootstrapped: true, access_token_valid: usable(row), access_expires_at: row.access_expires_at ? new Date(row.access_expires_at).toISOString() : null, refresh_updated_at: row.refresh_updated_at ? new Date(row.refresh_updated_at).toISOString() : null, locked: row.lock_until > now(), last_error: row.last_error ?? null };
  }
  return { getAccessToken, invalidateAccessToken, state };
}

const defaultAuth = createMeliAuth();
export const getAccessToken = defaultAuth.getAccessToken;
export const invalidateAccessToken = defaultAuth.invalidateAccessToken;
export const getAuthState = defaultAuth.state;
