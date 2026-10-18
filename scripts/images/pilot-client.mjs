// Cliente mínimo del Worker temporal de Preview. Sólo HTTPS, sin redirecciones, con
// token por ejecución. `fetchFn` es inyectable para probar sin red.
export function pilotClient({ baseUrl, token, fetchFn = fetch }) {
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || !token) throw new Error('invalid-pilot-config');
  return async function call(path, { method = 'GET', body } = {}) {
    const response = await fetchFn(new URL(path, base), { method, redirect: 'manual', signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const bytes = new Uint8Array(await response.arrayBuffer());
    let json = null;
    if ((response.headers.get('content-type') || '').includes('json')) { try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { json = null; } }
    return { status: response.status, ok: response.ok, headers: response.headers, bytes, json };
  };
}
