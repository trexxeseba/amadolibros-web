import {
  MAX_IMPORT_ITEMS,
  importCovers,
  manifestSummary,
  readManifest,
} from './lib/cover-pilot.js';

const SECRET_HEADER = 'Authorization';
const MAX_REQUEST_BYTES = 64 * 1024;

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length === 0 || a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

async function readJsonBody(request) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw Object.assign(new Error('Content-Type debe ser application/json.'), {
      status: 415,
      code: 'CONTENT_TYPE_INVALID',
    });
  }

  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('El cuerpo excede 64 KiB.'), {
      status: 413,
      code: 'REQUEST_TOO_LARGE',
    });
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) {
    throw Object.assign(new Error('El cuerpo excede 64 KiB.'), {
      status: 413,
      code: 'REQUEST_TOO_LARGE',
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('JSON inválido.'), {
      status: 400,
      code: 'JSON_INVALID',
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const expectedSecret = typeof env?.COVER_PILOT_SECRET === 'string'
      ? env.COVER_PILOT_SECRET.trim()
      : '';

    // El Worker no revela si el secreto todavía no fue configurado.
    if (!expectedSecret) return new Response('Not found', { status: 404 });

    const supplied = request.headers.get(SECRET_HEADER) || '';
    if (!timingSafeEqual(supplied, `Bearer ${expectedSecret}`)) {
      return json({ error: 'No autorizado.' }, 401);
    }

    if (!env?.COVER_R2 || typeof env.COVER_R2.get !== 'function' ||
        typeof env.COVER_R2.put !== 'function') {
      return json({ error: 'Binding COVER_R2 no disponible.' }, 503);
    }

    if (request.method === 'GET' && url.pathname === '/status') {
      try {
        const manifest = await readManifest(env.COVER_R2);
        return json({
          status: 'ready',
          scope: env.PILOT_SCOPE || 'preview-20',
          max_items_per_run: MAX_IMPORT_ITEMS,
          manifest: manifestSummary(manifest),
        });
      } catch (error) {
        return json({ error: 'Manifest inválido.', code: error.code || 'MANIFEST_INVALID' }, 503);
      }
    }

    if (request.method === 'POST' && url.pathname === '/import') {
      try {
        const payload = await readJsonBody(request);
        const result = await importCovers(env, payload);
        return json(result, result.failed > 0 ? 207 : 200);
      } catch (error) {
        return json({
          error: error.message || 'Error de importación.',
          code: error.code || 'IMPORT_FAILED',
        }, error.status || 500);
      }
    }

    return json({ error: 'Not found.' }, 404);
  },
};
