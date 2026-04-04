/**
 * worker-sync/meli-auth.js
 *
 * Obtiene un ML access token usando el refresh token rotativo.
 *
 * KV es la ÚNICA fuente de auth:refresh_token — no hay fallback a env vars.
 * Si KV no tiene el token, el sync falla con mensaje claro.
 * Ver bootstrapping manual en README (sección F de la guía de deploy).
 *
 *   - Lock distribuido (auth:refresh_token_lock) para evitar race conditions
 *   - Guarda el nuevo refresh_token en KV inmediatamente después de cada uso
 *   - Backoff exponencial en caso de invalid_grant (race condition entre Workers)
 *
 * KV keys usadas:
 *   auth:refresh_token       — refresh token vigente (compartido con Pages)
 *   auth:refresh_token_lock  — lock mutex para el intercambio de token
 */

const LOCK_TTL      = 60;   // segundos — mínimo KV TTL permitido
const MAX_RETRIES   = 5;
const BASE_DELAY_MS = 200;

export async function getAccessToken(env) {
  const APP_ID        = env.APP_ID;
  const CLIENT_SECRET = env.CLIENT_SECRET;
  const KV_KEY        = 'auth:refresh_token';
  const LOCK_KEY      = 'auth:refresh_token_lock';

  if (!CLIENT_SECRET) {
    throw new Error('[Auth] CLIENT_SECRET no configurado. Ejecutá: wrangler secret put CLIENT_SECRET');
  }

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    // 1. Leer refresh token — KV es la única fuente de verdad
    const refreshToken = await env.AMADO_KV.get(KV_KEY);

    if (!refreshToken) {
      throw new Error(
        '[Auth] auth:refresh_token no encontrado en KV. ' +
        'Bootstrap: wrangler kv:key put --binding AMADO_KV auth:refresh_token "<token>" --env production'
      );
    }

    // 2. Verificar lock — otro Worker puede estar haciendo refresh
    const lockValue = await env.AMADO_KV.get(LOCK_KEY);
    if (lockValue) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
      console.log(`[Auth] Lock activo. Esperando ${Math.round(delay)}ms (intento ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(delay);
      continue;
    }

    // 3. Adquirir lock
    await env.AMADO_KV.put(LOCK_KEY, String(Date.now()), { expirationTtl: LOCK_TTL });

    try {
      // 4. Intercambiar refresh token por access token
      const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'refresh_token',
          client_id:     APP_ID,
          client_secret: CLIENT_SECRET,
          refresh_token: refreshToken,
        }),
      });

      const data = await resp.json();

      if (resp.ok && data.access_token) {
        // Éxito: guardar nuevo refresh token antes de liberar lock
        if (data.refresh_token) {
          await env.AMADO_KV.put(KV_KEY, data.refresh_token, { expirationTtl: 86400 * 30 });
          console.log('[Auth] Nuevo refresh token guardado en KV.');
        }
        await env.AMADO_KV.delete(LOCK_KEY);
        return data.access_token;

      } else if (
        data.error === 'invalid_grant' ||
        (data.message && data.message.toLowerCase().includes('invalid'))
      ) {
        // Race condition: otro Worker ya usó este refresh token
        await env.AMADO_KV.delete(LOCK_KEY);
        const delay = BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * BASE_DELAY_MS;
        console.warn(`[Auth] invalid_grant — posible race condition. Reintentando en ${Math.round(delay)}ms.`);
        await sleep(delay);

      } else {
        await env.AMADO_KV.delete(LOCK_KEY);
        throw new Error(`[Auth] Error ML OAuth (HTTP ${resp.status}): ${JSON.stringify(data)}`);
      }

    } catch (err) {
      // Liberar lock ante cualquier error de red o JS
      await env.AMADO_KV.delete(LOCK_KEY).catch(() => {});
      if (attempt === MAX_RETRIES - 1) throw err;
      await sleep(BASE_DELAY_MS * Math.pow(2, attempt));
    }
  }

  throw new Error('[Auth] Falló obtener access token después de 5 intentos.');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
