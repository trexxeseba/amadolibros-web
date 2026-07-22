const MP_BASE              = 'https://api.mercadopago.com';
const MP_SANDBOX_HOSTNAMES = new Set(['sandbox.mercadopago.com', 'sandbox.mercadopago.com.uy']);
export const MP_COLLECTOR_ID = 3559407834;
export const MP_SITE_ID      = 'MLU';

export function validateSandboxUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && MP_SANDBOX_HOSTNAMES.has(u.hostname) && u.pathname.length > 1;
  } catch { return false; }
}

function validateMpResponse(data, { requireExternalRef = false, publicCode = '' } = {}) {
  if (!data || typeof data !== 'object') return 'respuesta vacía';
  if (typeof data.id !== 'string' || !data.id) return 'id ausente';
  if (!validateSandboxUrl(data.sandbox_init_point)) return 'sandbox_init_point inválido';
  if (data.collector_id !== undefined && data.collector_id !== MP_COLLECTOR_ID) return 'collector_id incorrecto';
  if (data.site_id !== undefined && data.site_id !== MP_SITE_ID) return 'site_id incorrecto';
  if (requireExternalRef && data.external_reference !== publicCode) return 'external_reference no coincide';
  return null;
}

function mpErrorCode(status) {
  if (status === 401) return 'MP_AUTH_ERROR';
  if (status === 429) return 'MP_RATE_LIMIT';
  return 'MP_API_ERROR';
}

async function fetchMp(url, opts, timeoutMs, fetchFn) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function createPreference(payload, accessToken, { fetch: f = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let resp;
  try {
    resp = await fetchMp(
      `${MP_BASE}/checkout/preferences`,
      {
        method:  'POST',
        headers: {
          'Authorization':     `Bearer ${accessToken}`,
          'Content-Type':      'application/json',
          'X-Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
      f
    );
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, code: 'MP_TIMEOUT' };
    return { ok: false, code: 'MP_API_ERROR' };
  }

  if (!resp.ok) return { ok: false, code: mpErrorCode(resp.status) };

  let data;
  try { data = await resp.json(); } catch { return { ok: false, code: 'MP_API_ERROR' }; }

  const err = validateMpResponse(data);
  if (err) return { ok: false, code: 'MP_API_ERROR' };
  return { ok: true, id: data.id, sandbox_init_point: data.sandbox_init_point };
}

export async function getPreference(prefId, accessToken, publicCode, { fetch: f = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let resp;
  try {
    resp = await fetchMp(
      `${MP_BASE}/checkout/preferences/${prefId}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } },
      timeoutMs,
      f
    );
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, code: 'MP_TIMEOUT' };
    return { ok: false, code: 'MP_API_ERROR' };
  }

  if (!resp.ok) return { ok: false, code: mpErrorCode(resp.status) };

  let data;
  try { data = await resp.json(); } catch { return { ok: false, code: 'MP_API_ERROR' }; }

  const err = validateMpResponse(data, { requireExternalRef: true, publicCode });
  if (err) return { ok: false, code: 'MP_API_ERROR' };
  return { ok: true, id: data.id, sandbox_init_point: data.sandbox_init_point };
}

export async function searchPreferenceByRef(publicCode, accessToken, now, { fetch: f = globalThis.fetch, timeoutMs = 10000 } = {}) {
  let resp;
  try {
    resp = await fetchMp(
      `${MP_BASE}/checkout/preferences/search?external_reference=${encodeURIComponent(publicCode)}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } },
      timeoutMs,
      f
    );
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, code: 'MP_TIMEOUT' };
    return { ok: false, code: 'MP_API_ERROR' };
  }

  if (!resp.ok) return { ok: false, code: 'MP_API_ERROR' };

  let data;
  try { data = await resp.json(); } catch { return { ok: false, code: 'MP_API_ERROR' }; }

  const elements = Array.isArray(data?.elements) ? data.elements : [];
  const nowMs    = now.getTime();

  const candidates = elements.filter(e => {
    if (e.external_reference !== publicCode) return false;
    if (e.collector_id !== undefined && e.collector_id !== MP_COLLECTOR_ID) return false;
    if (e.site_id !== undefined && e.site_id !== MP_SITE_ID) return false;
    if (e.expiration_date_to && Date.parse(e.expiration_date_to) <= nowMs) return false;
    return true;
  });

  if (candidates.length === 0) return { ok: false, code: 'NOT_FOUND' };

  candidates.sort((a, b) => Date.parse(b.date_created || '0') - Date.parse(a.date_created || '0'));
  return getPreference(candidates[0].id, accessToken, publicCode, { fetch: f, timeoutMs });
}
