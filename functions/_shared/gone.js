import { BASE } from './catalog.js';

/**
 * Respuesta compartida para URLs legacy eliminadas sin equivalente actual.
 * 410 permite a crawlers entender que la desaparición es permanente.
 */
export function goneResponse({
    message = 'Esta página ya no existe. Buscá el libro en el catálogo actualizado.',
    cacheSeconds = 86400,
} = {}) {
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Página no disponible — Amado Libros</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:600px;margin:4rem auto;padding:1rem;text-align:center;color:#1e293b}
    a{color:#3b82f6;text-decoration:none}a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <h1 style="font-size:1.5rem;margin-bottom:1rem">Esta página ya no existe</h1>
  <p style="color:#64748b;margin-bottom:1.5rem">${message}</p>
  <a href="${BASE}/catalogo">Ir al catálogo de Amado Libros</a>
</body>
</html>`;

    return new Response(html, {
        status: 410,
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': `public, max-age=${cacheSeconds}`,
            'x-robots-tag': 'noindex, nofollow',
        },
    });
}
