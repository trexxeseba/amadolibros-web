# Catálogo público de Amado Libros

`GET https://www.amadolibros.com/api/catalogo-publico`

Salida JSON de lectura, sin autenticación, para EncontráTuLibro y otros lectores
del catálogo público. No requiere acceso administrativo ni credenciales de ML.

La respuesta incluye `schema_version`, `catalog_version`, `complete`, `total`,
`counts` e `items`. Cada oferta tiene exclusivamente `id`, `title`, `author`,
`isbn`, `price`, `currency`, `stock`, `availability` y `url`.

- `in_stock`: precio web/tarjeta en UYU y stock publicados, usando exactamente
  el catálogo versionado y los ajustes de precio que consume el checkout.
- `on_request`: disponible para consultar por encargo; `stock: 0`, `price: null`.
  Nunca interpretar un precio nulo como cero pesos ni como compra inmediata.
- Autor e ISBN pueden ser nulos. Los identificadores conservan su valor textual.
- Los enlaces apuntan a las fichas de Amado, donde se coordina la compra.
- Se conservan ofertas con distinto ID, incluso si comparten ISBN. No sumar
  cantidades entre publicaciones repetidas del mismo libro.

Es un snapshot completo del catálogo público (incluye otros productos presentes
en él). Reemplazar el snapshot anterior solamente con HTTP 200 y `complete: true`.
Mantener la última copia válida ante HTTP 503; reintentar después de 60 segundos.
Se responde 503 si falta alguna fuente o si sus versiones no coinciden.

Consultar cada hora es suficiente para empezar. La caché del origen dura como
máximo 60 segundos; la frescura depende también de la sincronización del catálogo.
`catalog_version` identifica el snapshot de origen, no una fecha de consulta.
Los precios promocionales pueden cambiar con la misma versión del snapshot, por
lo que hay que leer la respuesta completa en cada actualización.

Se admiten GET, HEAD y OPTIONS. POST y demás escrituras devuelven 405. CORS permite
lectura desde otros sitios. No se exportan clientes, ventas, costos ni secretos.
