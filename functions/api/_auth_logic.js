// Lógica pura del ingreso por enlace mágico. Sin red, sin base, sin reloj
// propio: todo lo que decide se puede probar sin levantar nada.

export const TOKEN_TTL_MINUTES = 15;
export const SESSION_TTL_DAYS = 30;
export const MAX_BODY_BYTES = 4 * 1024;
export const MAX_EMAIL_LEN = 254;

// Nombre con prefijo __Host-: el navegador sólo lo acepta con Secure, Path=/
// y sin Domain, así que un subdominio no puede fijarle la cookie al sitio.
export const COOKIE_NAME = '__Host-al_sesion';

// Límite de envío. Sin esto, el endpoint es un cañón de correo gratuito
// apuntable a cualquier dirección ajena.
export const RATE_LIMITS = Object.freeze({
  porCorreo: { max: 3, ventanaSegundos: 15 * 60 },
  porIp: { max: 10, ventanaSegundos: 60 * 60 },
});

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > MAX_EMAIL_LEN) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function base64url(bytes) {
  let binario = '';
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 32 bytes de crypto.getRandomValues: no adivinable por fuerza bruta.
export function generarSecreto(getRandomValues = crypto.getRandomValues.bind(crypto)) {
  return base64url(getRandomValues(new Uint8Array(32)));
}

// Se guarda el hash, nunca el secreto. El secreto sólo existe en el correo
// del comprador y en la cookie de su navegador.
export async function hashSecreto(secreto, subtle = crypto.subtle) {
  const datos = new TextEncoder().encode(String(secreto));
  const digest = await subtle.digest('SHA-256', datos);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Un secreto con forma inválida se rechaza antes de tocar la base.
export function pareceSecreto(valor) {
  return typeof valor === 'string' && /^[A-Za-z0-9_-]{43}$/.test(valor);
}

export function vencimiento(desde, minutos) {
  return new Date(desde.getTime() + minutos * 60_000);
}

// El enlace se arma SIEMPRE con el origen canónico configurado, nunca con el
// Host de la petición: si se derivara del Host, cualquiera podría pedir un
// enlace con un Host falso y recibir en el correo de la víctima una URL
// apuntando a su propio servidor.
export function construirEnlace(canonicalOrigin, secreto) {
  const url = new URL('/ingresar', canonicalOrigin);
  url.searchParams.set('t', secreto);
  return url.toString();
}

export function construirCookie(secreto, { maxAgeSegundos }) {
  return `${COOKIE_NAME}=${secreto}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSegundos}`;
}

export function cookieDeBorrado() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function leerCookieDeSesion(cabecera) {
  if (typeof cabecera !== 'string' || !cabecera) return null;
  for (const parte of cabecera.split(';')) {
    const separador = parte.indexOf('=');
    if (separador === -1) continue;
    if (parte.slice(0, separador).trim() !== COOKIE_NAME) continue;
    const valor = parte.slice(separador + 1).trim();
    return pareceSecreto(valor) ? valor : null;
  }
  return null;
}

export function estaVencido(expiresAt, ahora) {
  const limite = Date.parse(expiresAt);
  return !Number.isFinite(limite) || limite <= ahora.getTime();
}

// Una fila de token sirve sólo si existe, no se usó y no venció. Se devuelve
// el motivo para poder distinguirlos en las pruebas y en el log, pero la
// respuesta al usuario es la misma en los tres casos.
export function tokenUtilizable(fila, ahora) {
  if (!fila) return { ok: false, motivo: 'inexistente' };
  if (fila.used_at) return { ok: false, motivo: 'ya_usado' };
  if (estaVencido(fila.expires_at, ahora)) return { ok: false, motivo: 'vencido' };
  return { ok: true, email: fila.email };
}

export function sesionUtilizable(fila, ahora) {
  if (!fila) return { ok: false, motivo: 'inexistente' };
  if (fila.revoked_at) return { ok: false, motivo: 'revocada' };
  if (estaVencido(fila.expires_at, ahora)) return { ok: false, motivo: 'vencida' };
  return { ok: true, email: fila.email };
}

export function superaLimite(cuenta, limite) {
  return Number.isFinite(cuenta) && cuenta >= limite.max;
}

// El comprador ve su pedido, no la fila entera de la base: nada de
// fingerprints, claves de idempotencia ni identificadores de pago.
export function pedidoPublico(fila, items = []) {
  return {
    codigo: fila.public_code,
    estado: fila.status,
    estado_pago: fila.payment_status,
    entrega: fila.delivery_type,
    total_uyu: fila.payable_total_uyu,
    moneda: fila.currency,
    creado: fila.created_at,
    articulos: items.map(item => ({
      titulo: item.title,
      cantidad: item.quantity,
      precio_unitario_uyu: item.unit_price_uyu,
      total_linea_uyu: item.line_total_uyu,
    })),
  };
}

function escaparHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function construirCorreoDeIngreso({ enlace, minutosDeVigencia = TOKEN_TTL_MINUTES }) {
  const seguro = escaparHtml(enlace);
  return {
    subject: 'Tu enlace para ver tus pedidos en Amado Libros',
    text: [
      'Entrá a ver tus pedidos con este enlace:',
      '',
      enlace,
      '',
      `El enlace vence en ${minutosDeVigencia} minutos y sirve una sola vez.`,
      'Si no lo pediste, ignorá este correo: nadie entró a tu cuenta.',
    ].join('\n'),
    html: [
      '<p>Entrá a ver tus pedidos con este enlace:</p>',
      `<p><a href="${seguro}">Ver mis pedidos</a></p>`,
      `<p>El enlace vence en ${minutosDeVigencia} minutos y sirve una sola vez.</p>`,
      '<p>Si no lo pediste, ignorá este correo: nadie entró a tu cuenta.</p>',
    ].join(''),
  };
}
