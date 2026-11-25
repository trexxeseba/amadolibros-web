// GET /api/checkout-health — diagnóstico del cobro para el monitor externo.
//
// Responde 200 {ok:true} sólo si todo lo que hace falta para cobrar está en
// pie: configuración, interruptor de cobros, base de pedidos, catálogo del
// carrito, verificación anti-robots, credenciales de Mercado Pago vigentes y
// de la cuenta correcta, clave de avisos de pago y correo de avisos.
// Cualquier pieza caída → 503 con el nombre de la pieza.
//
// Es de sólo lectura: no crea pedidos, no pide pagos, no manda correos. La
// respuesta lleva únicamente 'ok' o 'falla' por pieza: ni valores, ni claves,
// ni mensajes de error del proveedor.
//
// Qué NO prueba: que una compra real termine bien. No resuelve el desafío
// anti-robots, no paga en Mercado Pago y no recibe un aviso firmado. Eso lo
// cubre una compra de prueba (docs/alarmas-del-cobro.md).

import { resolveConfig } from './_env_config.js';

const MP_USERS_ME = 'https://api.mercadopago.com/users/me';
const MP_TIMEOUT_MS = 6000;
// La consulta a Mercado Pago se guarda: el endpoint es público y no tiene que
// poder usarse para golpear la API de Mercado Pago a repetición. Un resultado
// bueno vale 5 minutos; una falla, 1 minuto (la recuperación se ve enseguida).
// La clave del guardado lleva el entorno, la cuenta y una huella de la
// credencial: un resultado de una vista previa nunca sirve para producción, y
// una credencial cambiada se consulta de nuevo.
const MP_CACHE_PREFIX = 'checkout-health:mp:v2';
const MP_OK_TTL_SECONDS = 300;
const MP_FAIL_TTL_SECONDS = 60;

const OK = 'ok';
const FAIL = 'falla';

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
}

const present = value => typeof value === 'string' && value.trim().length > 0;

async function checkOrdersDb(db) {
  if (!db) return FAIL;
  try {
    // Lee las tres tablas que usa una compra; falla si falta alguna.
    await db.prepare('SELECT 1 FROM orders LIMIT 1').first();
    await db.prepare('SELECT 1 FROM order_items LIMIT 1').first();
    await db.prepare('SELECT 1 FROM order_events LIMIT 1').first();
    return OK;
  } catch {
    return FAIL;
  }
}

async function checkCatalog(fetchCatalog, context) {
  try {
    const catalog = await fetchCatalog(context);
    return catalog && Array.isArray(catalog.items) && catalog.items.length > 0 ? OK : FAIL;
  } catch {
    return FAIL;
  }
}

async function queryMercadoPago(token, collectorId, fetchFn) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MP_TIMEOUT_MS);
  try {
    const response = await fetchFn(MP_USERS_ME, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!response.ok) return FAIL;
    const data = await response.json().catch(() => null);
    return Number(data?.id) === collectorId ? OK : FAIL;
  } catch {
    return FAIL;
  } finally {
    clearTimeout(timer);
  }
}

async function mpCacheKey({ appEnv, collectorId, token }) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  const print = [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${MP_CACHE_PREFIX}:${appEnv}:${collectorId}:${print}`;
}

function fresh(entry, now) {
  if (!entry || (entry.result !== OK && entry.result !== FAIL)) return null;
  const age = now.getTime() - Date.parse(entry.at);
  const ttl = entry.result === OK ? MP_OK_TTL_SECONDS : MP_FAIL_TTL_SECONDS;
  return age >= 0 && age < ttl * 1000 ? entry.result : null;
}

// `memory` e `inflight` viven mientras viva el proceso que atiende: frenan las
// consultas repetidas aunque KV no esté o falle, y hacen que las llamadas
// simultáneas compartan una sola consulta a Mercado Pago.
async function checkMercadoPago({ token, collectorId, appEnv, kv, fetchFn, now, memory, inflight }) {
  if (!present(token)) return FAIL;
  const key = await mpCacheKey({ appEnv, collectorId, token });

  const remembered = fresh(memory.get(key), now);
  if (remembered) return remembered;
  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    if (kv) {
      try {
        const cached = fresh(JSON.parse(await kv.get(key) || 'null'), now);
        if (cached) return cached;
      } catch { /* sin guardado legible: se consulta */ }
    }
    const result = await queryMercadoPago(token, collectorId, fetchFn);
    const entry = { result, at: now.toISOString() };
    memory.set(key, entry);
    if (kv) {
      const ttl = result === OK ? MP_OK_TTL_SECONDS : MP_FAIL_TTL_SECONDS;
      try { await kv.put(key, JSON.stringify(entry), { expirationTtl: ttl }); } catch { /* queda la memoria */ }
    }
    return result;
  })();
  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

export function createCheckoutHealthHandler({ fetchCatalog, fetchFn = (...args) => globalThis.fetch(...args), getNow = () => new Date() }) {
  const memory = new Map();
  const inflight = new Map();
  return async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Método no permitido.' }, 405);
    }

    const now = getNow();
    const config = resolveConfig(env);
    const checks = {
      configuracion: config.ok ? OK : FAIL,
      cobros_encendidos: config.ok && config.checkoutEnabled ? OK : FAIL,
      base_de_pedidos: FAIL,
      catalogo: FAIL,
      verificacion_anti_robots: present(env?.TURNSTILE_SECRET_KEY) ? OK : FAIL,
      mercado_pago: FAIL,
      clave_de_avisos_de_pago: present(env?.MP_WEBHOOK_SECRET) ? OK : FAIL,
      correo_de_avisos: present(env?.RESEND_API_KEY) && present(env?.SALES_NOTIFICATION_FROM) && present(env?.SALES_NOTIFICATION_TO) ? OK : FAIL,
    };

    const [db, catalog, mp] = await Promise.all([
      checkOrdersDb(env?.ORDERS_DB),
      checkCatalog(fetchCatalog, context),
      config.ok
        ? checkMercadoPago({ token: env?.MP_ACCESS_TOKEN, collectorId: config.mpCollectorId, appEnv: config.appEnv, kv: env?.AMADO_KV, fetchFn, now, memory, inflight })
        : Promise.resolve(FAIL),
    ]);
    checks.base_de_pedidos = db;
    checks.catalogo = catalog;
    checks.mercado_pago = mp;

    const ok = Object.values(checks).every(value => value === OK);
    return json({ ok, checked_at: now.toISOString(), checks }, ok ? 200 : 503);
  };
}
