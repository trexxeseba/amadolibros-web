const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstile(token, secret, ip = '', {
  fetch: fetchFn = globalThis.fetch,
  action = 'prepare_order',
  allowedHostname = 'amadolibros-web.pages.dev',
} = {}) {
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 5000);
  let resp;
  try {
    resp = await fetchFn(SITEVERIFY_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ secret, response: token, remoteip: ip }),
      signal:  controller.signal,
    });
  } catch (err) {
    clearTimeout(tid);
    return { ok: false, code: err?.name === 'AbortError' ? 'SITEVERIFY_TIMEOUT' : 'SITEVERIFY_ERROR' };
  }
  clearTimeout(tid);

  if (!resp.ok) return { ok: false, code: 'SITEVERIFY_ERROR' };

  let data;
  try   { data = await resp.json(); }
  catch { return { ok: false, code: 'SITEVERIFY_ERROR' }; }

  if (!data.success) {
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    if (codes.some(c => c === 'internal-error' || c === 'missing-input-secret' || c === 'invalid-input-secret')) {
      return { ok: false, code: 'SITEVERIFY_ERROR' };
    }
    return { ok: false, code: codes.includes('timeout-or-duplicate') ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' };
  }

  if (data.action !== action) return { ok: false, code: 'ACTION_INVALID' };
  const h = data.hostname || '';
  if (h !== allowedHostname && !h.endsWith('.' + allowedHostname)) return { ok: false, code: 'HOSTNAME_INVALID' };

  return { ok: true };
}
