/**
 * functions/producto/[[path]].js
 *
 * Limpieza de URLs viejas del sitio anterior (WooCommerce / CMS legacy).
 * Patrón: /producto/:slug/
 *
 * Devuelve 410 Gone — indica a Google que estas páginas son
 * permanentemente eliminadas y deben ser removidas del índice.
 * Es preferible a un soft 404 (200 con index.html) o a un 301
 * al homepage cuando no existe mapeo directo al nuevo /libro/:id/:slug.
 */

export async function onRequest() {
    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Página no disponible — Amado Libros</title>
  <meta name="robots" content="noindex">
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         max-width:600px;margin:4rem auto;padding:1rem;text-align:center;color:#1e293b}
    a{color:#3b82f6;text-decoration:none}
    a:hover{text-decoration:underline}
  </style>
</head>
<body>
  <h1 style="font-size:1.5rem;margin-bottom:1rem">Esta página ya no existe</h1>
  <p style="color:#64748b;margin-bottom:1.5rem">
    El catálogo fue actualizado. Buscá tu libro en el catálogo completo.
  </p>
  <a href="/">← Ir al catálogo de Amado Libros</a>
</body>
</html>`;

    return new Response(html, {
        status: 410,
        headers: {
            'content-type': 'text/html;charset=UTF-8',
            'cache-control': 'public, max-age=86400',
        },
    });
}
