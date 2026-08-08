# SEO-CRAWL-LOGS-3

Observabilidad agregada del rastreo después de `SEO-LEGACY-URL-CLEANUP-1`.

## Objetivo

Medir si Googlebot dedica una proporción creciente de sus visitas a URLs canónicas útiles y una proporción decreciente a legacy, parámetros y variantes.

No es un sistema de access logs general.

## Captura — opción B

Se registran:

1. requests cuyo User-Agent parezca bot/crawler;
2. todos los patrones legacy;
3. una muestra aleatoria del 1% del resto del tráfico no-asset.

Los assets (`/_astro/*`, CSS, JS, imágenes y fonts) se excluyen.

## Privacidad / cardinalidad

D1 **no persiste**:

- IP;
- User-Agent;
- URL o path crudo;
- query string;
- MLU;
- ISBN;
- identificadores de cliente.

Solo persiste agregados por:

`date + pattern + status + verified + ua_googlebot`.

## Verificación Googlebot

Un request cuenta como Googlebot verificado únicamente cuando se cumplen las dos condiciones:

1. el User-Agent contiene `Googlebot`;
2. `CF-Connecting-IP` pertenece a un CIDR publicado por Google en `common-crawlers.json`.

Estados internos del campo `verified`:

- `1`: UA Googlebot + IP dentro de rango oficial;
- `0`: UA Googlebot + IP válida fuera de los rangos oficiales;
- `-1`: request que no declara UA Googlebot;
- `-2`: UA Googlebot pero verificación no disponible (IP/rangos no disponibles o inválidos).

Los CIDR IPv4 e IPv6 se parsean a `BigInt` una vez por isolate y se mantienen en memoria una hora. La fuente se refresca lógicamente cada 24 h. Se guarda la última copia correcta en `AMADO_KV`; si Google no responde, se usa esa copia aunque sea anterior a 24 h.

Fuente oficial:

`https://developers.google.com/static/crawling/ipranges/common-crawlers.json`

## Kill switch

El logger está **apagado por defecto**.

Clave KV por entorno:

- Producción: `seo:crawl-logs-3:enabled:production`
- Preview: `seo:crawl-logs-3:enabled:preview`

Valor habilitante exacto: `true`.

Cualquier otro valor o ausencia de la clave = apagado.

El flag se cachea por isolate durante 60 segundos. Como KV es eventualmente consistente entre datacenters, el apagado global puede tardar adicionalmente el tiempo de propagación de KV.

## Camino crítico

`functions/_middleware.js` determina primero la respuesta normal. Después llama `scheduleCrawlAnalytics()`.

Toda la lógica de observabilidad queda dentro de `context.waitUntil()`:

- lectura del flag;
- decisión de muestreo;
- carga/refresco de rangos de Google;
- verificación IP;
- `CREATE TABLE IF NOT EXISTS` por isolate;
- upsert D1.

El cuerpo de la respuesta **nunca se clona, lee ni bufferea**. `bytes_sum` usa únicamente `Content-Length` cuando existe; `bytes_known_count` permite distinguir bytes medidos de respuestas sin longitud conocida.

## D1

Tabla: `crawl_stats`.

Schema versionado también en `migrations/0004_crawl_stats.sql`.

El runtime hace `CREATE TABLE IF NOT EXISTS` dentro de `waitUntil()` para que activar/desactivar observabilidad no requiera una migración bloqueante antes del deploy.

Cada request capturado ejecuta un único UPSERT agregado, no un INSERT de evento individual.

## useful_crawl_ratio_v1 — definición congelada

Versión: `1`.

Numerador:

> requests Googlebot verificadas (`verified=1`) con HTTP 200 y patrón `home`, `libro`, `libros`, `catalogo` o `static_page`.

Denominador:

> todas las requests Googlebot verificadas clasificadas como páginas de contenido.

Se excluyen del denominador porque son infraestructura/no-página:

- `asset`;
- `api`;
- `sitemap`;
- `robots`.

Legacy, variantes, parámetros y `other` **sí permanecen en el denominador**, porque justamente representan crawl de páginas que queremos reducir.

No cambiar esta definición sin crear `useful_crawl_ratio_v2`.

## Patrones

Principales dimensiones de baja cardinalidad:

- `home`, `home_param`
- `libro`, `libro_variant`
- `libros`, `libros_param`
- `catalogo`, `catalogo_param`
- `static_page`
- `legacy_book`
- `legacy_add_to_cart`
- `legacy_producto`
- `legacy_categoria_producto`
- `legacy_pagination`
- `legacy_root`
- `api`, `sitemap`, `robots`, `asset`, `other`

## Criterios de aceptación

- IPv4 e IPv6 cubiertos por tests.
- Un UA Googlebot con IP ajena a Google queda `verified=0`.
- Flag apagado no toca D1 ni consulta rangos.
- Cero path/IP/UA crudo en binds de D1.
- `waitUntil()` es el único camino de escritura desde middleware.
- Fallos del logger no cambian la respuesta al usuario.
- `useful_crawl_ratio_v1` tiene tests de numerador/denominador.
- Primer reporte real se revisa después de acumular 48 h de Producción.
