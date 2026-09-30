# Export para Encontrá tu Libro

`GET /export/encontra-tu-libro.json`

Endpoint de sólo lectura para compartir con Encontrá tu Libro el subconjunto
vendible del catálogo, sin entregar la URL pública de R2 ni el catálogo interno
completo.

- Ruta: `functions/export/encontra-tu-libro.json.js`
- Autenticación y caché: `functions/api/_export_etl_handler.js`
- Selección, campos y cálculos: `functions/api/_export_etl_logic.js`
- Pruebas: `functions/__tests__/export-encontra-tu-libro.test.js`

## Qué incluye

Libros activos con stock inmediato, en pesos uruguayos. Sin agotados ni
publicaciones por encargo.

Campos, y nada más que esos (`CAMPOS_EXPORTADOS`):

- `id` — identificador estable de la publicación (`MLU…`).
- `titulo`.
- `autor` — o `null` si falta o es genérico ("Varios", "Desconocido"). No se
  inventa ni se sustituye.
- `isbn13` — validado con dígito de control, o `null`. No se inventa.
- `precio_tarjeta_uyu` — `Number(item.price)`, sin redondear, igual que la
  ficha.
- `precio_transferencia_uyu` — `Math.round(precio * 0.88)` sobre el precio sin
  redondear, la misma regla y el mismo redondeo que la ficha
  (`functions/libro/[[path]].js:461,465`). Redondear el precio de tarjeta antes
  de aplicar el descuento da otro número con precios decimales: con 1000,5
  daría 881 y la ficha muestra 880.
- `condicion` — `nuevo`, `usado` o `desconocida`. Nunca se asume `usado`.
- `disponibilidad` — etiqueta (`en_stock`), no la cantidad exacta.
- `url_ficha` — la ficha en Amado, nunca el permalink de Mercado Libre.

No se publican cantidades exactas, datos de clientes, pedidos, costos,
proveedores ni ningún otro campo interno. Hay una prueba que lo fija.

Antes de evaluar la selección y de generar autor e ISBN se aplica
`applyBookEnrichment`, igual que la ficha (`functions/libro/[[path]].js:1167`),
para no entregar datos crudos peores que los ya publicados. El enriquecimiento
no muta el catálogo compartido y hay una prueba que lo fija.

## Seguridad

La protección del endpoint es la autenticación por cabecera:
`X-Amado-Export-Key`, comparada en tiempo constante contra el secreto
`ETL_EXPORT_KEY`. Sin secreto configurado el endpoint responde 503 y no sirve
datos: falla cerrado.

Todas las respuestas, incluidas las de rechazo, llevan
`Cache-Control: private, no-store, no-cache, must-revalidate` y
`Vary: X-Amado-Export-Key`, para que ningún intermediario pueda guardar una
respuesta autenticada y devolverla a quien no tiene clave.

**robots.txt no protege nada.** Es una convención para robots que la respetan,
no un control de acceso. Y en concreto, `astro-front/public/robots.txt` no
cubre `/export/`: el `Disallow: /` de la línea 8 pertenece al grupo
`User-agent: GPTBot` (línea 7). El grupo general (línea 10) es `Allow: /` y
sólo excluye `/api/`, `/admin/` y `/panel`.

**Límite de solicitudes: NO implementado.** `wrangler.toml` no tiene ninguna
regla de rate limiting, y proponerla no la implementa. Si se quiere, hay que
configurarla aparte en Cloudflare.

### Alcance real de revocar la clave

Revocar o rotar `ETL_EXPORT_KEY` bloquea **este** endpoint, y nada más. No
vuelve privado el catálogo: estas rutas siguen sirviendo datos del mismo
catálogo sin ninguna clave, y son públicas a propósito porque alimentan la web
y a Google.

- `GET /feed.xml` (`functions/feed.xml.js`) — feed de Merchant con título,
  precio, ISBN/GTIN, imagen y enlace de todo el universo elegible.
- `GET /sitemap-books-active.xml` (`functions/sitemap-books-active.xml.js`) —
  una URL por cada libro activo con stock.
- `GET /catalogo` (`functions/catalogo.js`) — índice navegable en HTML.
- `GET /libro/<id>/<slug>` (`functions/libro/[[path]].js`) — cada ficha, con
  autoría, ISBN y los dos precios.

Ninguna de esas rutas se modifica acá. Lo que aporta la clave es control sobre
esta descarga en particular: se puede revocar sin tocar la web.

## Contrato para el receptor

La respuesta es una **foto completa** (`tipo: "foto_completa"`) del universo
elegible en el momento de la consulta, no un incremental.

- **Un artículo ausente** debe retirarse de esta integración de stock
  inmediato. Eso **no** significa necesariamente que Amado ya no lo venda:
  puede estar sin stock, pausado, en otra moneda o disponible por encargo. No
  corresponde tratarlo como baja definitiva del catálogo.
- **Ante un error:** HTTP 503, una descarga incompleta o JSON inválido, hay que
  **conservar el último catálogo válido y reintentar**. Nunca vaciar el índice
  con una respuesta que no se pudo leer entera.
- Un catálogo de origen caído se responde 503 con `Retry-After: 300`, no como
  export vacío: un export vacío sería indistinguible de "ya no vendemos nada".
- `fuente_actualizada` es la fecha del catálogo (`catalog.json.updated_at`), no
  la hora de la descarga. Si la fuente no la informa va `null` y
  `fuente_actualizada_nota` lo dice; no se rellena con la hora de la consulta.
- `totales.excluidos_por_motivo` desglosa por qué quedó afuera cada ítem, y los
  números cierran contra `en_catalogo`.

## Publicar y verificar

1. Configurar `ETL_EXPORT_KEY` en Cloudflare Pages, ambiente Production, con un
   secreto generado al momento (por ejemplo `openssl rand -hex 32`).
2. Desplegar. Antes de dar la URL por comprobada, confirmar qué versión quedó
   realmente publicada.
3. Verificar, desde una máquina con salida a producción:
   - sin cabecera → 401;
   - con la clave → 200, y `totales.incluidos + totales.excluidos ==
     totales.en_catalogo`;
   - `Cache-Control` con `no-store` en las dos respuestas.
4. Entregar la clave al receptor por un canal fuera de banda. No va en el
   repositorio, ni en un ticket, ni en un PR.
