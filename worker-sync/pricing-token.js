/**
 * worker-sync/pricing-token.js
 *
 * GET /pricing/token — entrega el access token vigente de Mercado Libre al motor
 * local de precios de la PC, sin exponer nunca el refresh token.
 *
 *   - Secreto propio: PRICING_TOKEN_SECRET (distinto de SYNC_SECRET). Si no está
 *     configurado, la ruta responde 404: queda apagada hasta cargarlo.
 *   - La renovación sigue siendo de meli-auth.js (único gestor, con lock en D1).
 *     Esta ruta sólo llama a getAccessToken, que renueva si hace falta con el
 *     mismo lock; nunca toca el refresh token por su cuenta.
 *   - expires_in sale del vencimiento real guardado en ml_oauth (que a su vez viene
 *     del expires_in de la respuesta de ML), no de una duración fija.
 *   - Respuesta con Cache-Control: no-store. Nunca se loguea el token ni el secreto.
 */
import { getAccessToken as defaultGetAccessToken, MeliAuthError } from './meli-auth.js';

export const PRICING_TOKEN_PATH = '/pricing/token';
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' };
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: NO_STORE });

// Comparación en tiempo constante (sobre bytes, sin cortar antes por largo distinto).
export function sameSecret(given, expected) {
  const enc = new TextEncoder();
  const a = enc.encode(String(given ?? '')), b = enc.encode(String(expected ?? ''));
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0 && b.length > 0;
}

export async function handlePricingToken(request, env, { getAccessToken = defaultGetAccessToken, now = Date.now } = {}) {
  const secret = env?.PRICING_TOKEN_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return reply({ error: 'not_found' }, 404);
  if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
  // Nunca aceptar el mismo valor que SYNC_SECRET: son dos llaves con alcances distintos.
  if (env.SYNC_SECRET && sameSecret(secret, env.SYNC_SECRET)) return reply({ error: 'misconfigured' }, 500);
  const auth = request.headers.get('Authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!sameSecret(given, secret)) return reply({ error: 'unauthorized' }, 401);

  let token;
  try { token = await getAccessToken(env); }
  catch (error) {
    const code = error instanceof MeliAuthError ? error.code : 'auth_error';
    const retryable = error instanceof MeliAuthError ? error.retryable : true;
    return reply({ error: code, retryable }, retryable ? 503 : 502);
  }
  let expiresAt = 0;
  try {
    const row = await env.ORDERS_DB.prepare('SELECT access_expires_at FROM ml_oauth WHERE app_id=? AND access_token=?').bind(String(env.APP_ID ?? ''), token).first();
    expiresAt = Number(row?.access_expires_at) || 0;
  } catch { expiresAt = 0; }
  // Sin vencimiento conocido: expires_in 0 le dice al cliente que lo use para esta corrida y no lo guarde.
  const expiresIn = expiresAt > now() ? Math.floor((expiresAt - now()) / 1000) : 0;
  return reply({
    access_token: token,
    token_type: 'Bearer',
    expires_in: expiresIn,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    user_id: String(env.USER_ID ?? ''),
  });
}
