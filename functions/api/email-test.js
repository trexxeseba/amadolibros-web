import { sendSafeTestNotification } from './_sale_notification.js';

const TEST_TOKEN_SHA256 = '16585a0999dcdb783f838248803143f3d97a9c175c5a2aaecdca05ea8694360b';
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
};

function response(body, status = 200, contentType = 'text/plain; charset=utf-8') {
  return new Response(body, {
    status,
    headers: {
      ...SECURITY_HEADERS,
      'Content-Type': contentType,
    },
  });
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function tokenIsValid(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{48}$/.test(value)) return false;
  return (await sha256(value)) === TEST_TOKEN_SHA256;
}

async function readToken(request) {
  if (request.method === 'GET') {
    return new URL(request.url).searchParams.get('token') || '';
  }
  if (request.method === 'POST') {
    const contentType = request.headers.get('content-type') || '';
    if (!contentType.startsWith('application/x-www-form-urlencoded')) return '';
    const form = await request.formData();
    return form.get('token') || '';
  }
  return '';
}

function confirmationPage(token) {
  return `<!doctype html>
<html lang="es">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body style="font-family:Arial,sans-serif;max-width:620px;margin:48px auto;padding:0 20px">
    <h1>Prueba segura de email</h1>
    <p>Enviará un único correo a los destinatarios configurados. No crea pedidos ni contacta a Mercado Pago.</p>
    <form method="post">
      <input type="hidden" name="token" value="${token}">
      <button type="submit" style="padding:12px 18px;font-weight:700">Enviar prueba</button>
    </form>
  </body>
</html>`;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (env?.APP_ENV !== 'production') return response('Not Found', 404);
  if (request.method !== 'GET' && request.method !== 'POST') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { ...SECURITY_HEADERS, Allow: 'GET, POST' },
    });
  }

  const token = await readToken(request);
  if (!(await tokenIsValid(token))) return response('Not Found', 404);

  if (request.method === 'GET') {
    return response(confirmationPage(token), 200, 'text/html; charset=utf-8');
  }

  const missingBindings = [
    !String(env?.RESEND_API_KEY || '').trim() && 'API_KEY',
    !String(env?.SALES_NOTIFICATION_FROM || '').trim() && 'FROM',
    !String(env?.SALES_NOTIFICATION_TO || '').trim() && 'TO',
  ].filter(Boolean);
  if (missingBindings.length > 0) {
    return response(`FALLO — No se pudo enviar la prueba: EMAIL_CONFIG_MISSING_${missingBindings.join('_')}`);
  }

  let result;
  try {
    result = await sendSafeTestNotification({ env });
  } catch (error) {
    const errorName = String(error?.name || 'ERROR')
      .toUpperCase()
      .replace(/[^A-Z0-9_:-]/g, '')
      .slice(0, 40) || 'ERROR';
    const safeCode = `EMAIL_TEST_EXCEPTION_${errorName}`;
    console.error('[email-test] excepción controlada durante la prueba', {
      code: safeCode,
    });
    return response(`FALLO — No se pudo enviar la prueba: ${safeCode}`);
  }

  if (!result.ok) {
    const safeCode = /^[A-Z0-9_:-]{1,80}$/.test(result.code || '')
      ? result.code
      : 'RESEND_ERROR';
    console.error('[email-test] Resend no confirmó el correo', {
      code: safeCode,
    });
    // Cloudflare reemplaza respuestas 502 por su página genérica y oculta el
    // código seguro. Esta ruta es temporal: responde 200 para que el operador
    // pueda leer el diagnóstico y distingue el fallo con un prefijo explícito.
    return response(`FALLO — No se pudo enviar la prueba: ${safeCode}`);
  }

  return response('Prueba enviada correctamente.');
}
