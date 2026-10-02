import { fetchCatalog } from '../_shared/catalog.js';
import { CAMPOS_EXPORTADOS, construirExport } from './_export_etl_logic.js';

const NOMBRE_CABECERA = 'X-Amado-Export-Key';

// Comparación de largo constante: evita filtrar el largo o el prefijo de la
// clave por diferencia de tiempos.
function clavesIguales(a, b) {
  const A = new TextEncoder().encode(String(a ?? ''));
  const B = new TextEncoder().encode(String(b ?? ''));
  if (A.length !== B.length) return false;
  let distintos = 0;
  for (let i = 0; i < A.length; i += 1) distintos |= A[i] ^ B[i];
  return distintos === 0;
}

// `no-store` y `private` en TODAS las respuestas, incluidas las de rechazo.
// Sin esto, un intermediario podría guardar una respuesta autenticada y
// devolverla después a alguien sin clave. `Vary` sobre la cabecera de clave
// es el cinturón de seguridad si alguna capa igual decidiera cachear.
function cabeceras(extra = {}) {
  return {
    'Content-Type': 'application/json;charset=UTF-8',
    'Cache-Control': 'private, no-store, no-cache, must-revalidate',
    'Vary': NOMBRE_CABECERA,
    'X-Robots-Tag': 'noindex, nofollow',
    ...extra,
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: cabeceras(extra) });
}

export function crearExportHandler({ obtenerCatalogo = fetchCatalog } = {}) {
  return async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'GET') {
      return json({ error: 'Método no permitido.' }, 405, { Allow: 'GET' });
    }

    const secreto = String(env?.ETL_EXPORT_KEY || '').trim();

    // Falla cerrado: sin secreto configurado el endpoint NO sirve datos. Un
    // export abierto por olvido de configuración es justamente lo que se
    // quiso evitar al no entregar la URL pública de R2.
    if (!secreto) {
      return json({
        error: 'Export no disponible.',
        code: 'export_no_configurado',
      }, 503);
    }

    const enviada = request.headers.get(NOMBRE_CABECERA) || '';
    if (!clavesIguales(enviada, secreto)) {
      return json({ error: 'No autorizado.' }, 401, { 'WWW-Authenticate': `Key realm="export"` });
    }

    let catalogo;
    try {
      catalogo = await obtenerCatalogo(context);
    } catch {
      catalogo = null;
    }

    // Un catálogo caído no se sirve como export vacío: sería indistinguible
    // de "ya no vendemos nada" y el receptor borraría su índice entero.
    if (!catalogo || !Array.isArray(catalogo.items) || catalogo.items.length === 0) {
      return json({
        error: 'Catálogo temporalmente no disponible.',
        code: 'catalogo_no_disponible',
      }, 503, { 'Retry-After': '300' });
    }

    const resultado = construirExport(catalogo);
    return json({ ...resultado, campos: CAMPOS_EXPORTADOS }, 200);
  };
}

export { NOMBRE_CABECERA };
