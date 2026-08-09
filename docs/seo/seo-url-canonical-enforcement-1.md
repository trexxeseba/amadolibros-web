# SEO-URL-CANONICAL-ENFORCEMENT-1

Objetivo: asegurar una sola URL servible por ficha de producto.

Comportamiento esperado:

- `/libro/MLU...` -> 301 a `/libro/MLU.../{slug-canonico}`.
- `/libro/MLU.../{slug-incorrecto}` -> 301 al slug canónico.
- El redirect conserva la query string, salvo `layout`, que es un parámetro legacy de presentación y se elimina.
- El slug correcto sigue respondiendo normalmente, sin loop.
- En Producción, una variante non-www puede colapsar directamente al host `www` canónico.

No cambia catálogo, precio, stock, sitemap, Merchant Center ni contenido de las fichas.
