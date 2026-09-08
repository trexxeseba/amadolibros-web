// ADMIN-WEB-01: Cloudflare Access autentica; esta ruta verifica la firma y
// autoriza una lista explícita. No reutiliza sesiones de compradores.
const encoder = new TextEncoder();
let keyCache = null;

function decodePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('JWT_ENCODING');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

function accessToken(request) {
  // Access entrega el mismo JWT por cabecera y por cookie del dominio de la
  // aplicación. Preferir la cabecera; nunca rescatar una cabecera inválida
  // con otra identidad de la cookie. Ambas vías pasan por la misma firma.
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header !== null) return header;
  const cookies = request.headers.get('Cookie') || '';
  if (cookies.length > 32768) return null;
  const matches = cookies.split(';').map(value => value.trim()).filter(value => value.startsWith('CF_Authorization='));
  return matches.length === 1 ? matches[0].slice('CF_Authorization='.length) : null;
}

export async function checkAdminAccess(request, env, { fetchFn = fetch, now = Date.now() } = {}) {
  // Referencias cerradas de soporte: no devolver ni registrar claims, tokens,
  // cookies, correos, claves o mensajes del proveedor.
  const deny = reference => ({ ok: false, reference });
  const team = env.ADMIN_WEB_ACCESS_TEAM;
  const audience = env.ADMIN_WEB_ACCESS_AUD;
  const emails = String(env.ADMIN_WEB_ALLOWED_EMAILS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(team || '') ||
      typeof audience !== 'string' || !audience || !emails.length) return deny('A01');
  const token = accessToken(request);
  if (!token || token.length > 8192) return deny('A02');
  let phase = 'A03';
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return deny('A03');
    const header = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    const issuer = `https://${team}`;
    const nowSeconds = now / 1000;
    if (!header || !claims || header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit) return deny('A03');
    if (claims.iss !== issuer || !Array.isArray(claims.aud) || !claims.aud.includes(audience)) return deny('A04');
    if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds ||
        !Number.isFinite(claims.iat) || claims.iat > nowSeconds + 30 ||
        (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > nowSeconds))) return deny('A05');
    if (typeof claims.sub !== 'string' || !claims.sub || typeof claims.email !== 'string' ||
        !emails.includes(claims.email.toLowerCase())) return deny('A06');
    // Cache acotada por emisor, nunca por una URL recibida del navegador.
    phase = 'A07';
    if (!keyCache || keyCache.issuer !== issuer || keyCache.until <= now ||
        !keyCache.keys.some(k => k.kid === header.kid)) {
      const response = await fetchFn(`${issuer}/cdn-cgi/access/certs`, {
        redirect: 'error', signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return deny('A07');
      const body = await response.json();
      if (!Array.isArray(body.keys) || body.keys.length > 10) return deny('A07');
      keyCache = { issuer, keys: body.keys, until: now + 300000 };
    }
    const jwk = keyCache.keys.find(k => k.kid === header.kid && k.kty === 'RSA' &&
      (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    if (!jwk) return deny('A07');
    phase = 'A08';
    const key = await crypto.subtle.importKey('jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, decodePart(parts[2]),
      encoder.encode(`${parts[0]}.${parts[1]}`));
    return valid ? { ok: true } : deny('A08');
  } catch {
    return deny(phase);
  }
}

export async function verifyAdminAccess(request, env, options) {
  return (await checkAdminAccess(request, env, options)).ok;
}
