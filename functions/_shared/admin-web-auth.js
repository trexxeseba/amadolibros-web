// ADMIN-WEB-01: Cloudflare Access autentica; esta ruta verifica la firma y
// autoriza una lista explícita. No reutiliza sesiones de compradores.
const encoder = new TextEncoder();
let keyCache = null;

function decodePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('JWT_ENCODING');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

export async function verifyAdminAccess(request, env, { fetchFn = fetch, now = Date.now() } = {}) {
  const team = env.ADMIN_WEB_ACCESS_TEAM;
  const audience = env.ADMIN_WEB_ACCESS_AUD;
  const emails = String(env.ADMIN_WEB_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(team || '') ||
      typeof audience !== 'string' || !audience || !emails.length) return false;
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || token.length > 8192) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    const issuer = `https://${team}`;
    const nowSeconds = now / 1000;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit ||
        claims.iss !== issuer || !Array.isArray(claims.aud) || !claims.aud.includes(audience) ||
        !Number.isFinite(claims.exp) || claims.exp <= nowSeconds ||
        !Number.isFinite(claims.iat) || claims.iat > nowSeconds + 30 ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds)) ||
        typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string' ||
        !emails.includes(claims.email.toLowerCase())) return false;
    // Cache acotada por emisor, nunca por una URL recibida del navegador.
    if (!keyCache || keyCache.issuer !== issuer || keyCache.until <= now ||
        !keyCache.keys.some(k => k.kid === header.kid)) {
      const response = await fetchFn(`${issuer}/cdn-cgi/access/certs`, {
        redirect: 'error', signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return false;
      const body = await response.json();
      if (!Array.isArray(body.keys) || body.keys.length > 10) return false;
      keyCache = { issuer, keys: body.keys, until: now + 300000 };
    }
    const jwk = keyCache.keys.find(k => k.kid === header.kid && k.kty === 'RSA' &&
      (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodePart(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return false;
  }
}
