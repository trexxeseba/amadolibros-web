# Imágenes de Amado: reducir transformaciones manteniendo calidad

## Evidencia y alcance

Revisión de main `3af2664e076d44ddb309a7a9fd7ce687d0991161` y capturas aportadas el 11/10/2026. El consumo observado del ciclo 15/09–14/10, con datos hasta 12/10 UTC, es US$71,35: Images Transformed US$63 (88,3%), Workers CPU US$8,26 y R2 US$0,09. Cloudflare proyecta US$76,45 de consumo al cierre. El panel excluye suscripciones fijas. Con los dos planes de US$5 de la factura anterior, todavía activos en las capturas, la estimación conjunta es US$86,45 si sus tarifas permanecen iguales; no es una factura emitida. El registro anual del dominio vintage no se vuelve a sumar.

La tabla muestra 130,53 mil transformaciones totales y 125,53 mil facturables, y 442,47 millones de ms CPU totales / 412,47 millones facturables. Las cantidades abreviadas no permiten recalcular el precio exacto con centavos: los US$63 del panel son la evidencia monetaria. Los picos de primeros días de octubre requieren logs antes de atribuirlos a usuarios, crawlers o auditorías.

Fuentes: capturas de Uso facturable y Suscripciones aportadas en esta conversación; factura IN-79358685 del 15/09; [alcance de Uso facturable](https://developers.cloudflare.com/billing/manage/billable-usage/); [regla mensual de transformaciones incluso en caché](https://developers.cloudflare.com/images/optimization/transformations/overview/).

## Qué hace hoy el código

- `functions/_shared/cloudflare-images.js` y `astro-front/src/lib/cloudflare-images.js` generan URLs `/cdn-cgi/image/` con tamaños y calidad en la URL.
- Listados: 240/360/480 px, calidad 85; tarjetas con encuadre ampliado pueden usar 480/720/960. Relacionados: 120/180/240.
- Ficha: 320/480/768/1024, calidad 85; miniaturas 96/calidad 82; zoom 1024/calidad 88. Cada combinación es distinta para facturación.
- `worker-sync/cover-mirror.js` conserva masters por hash en R2. `functions/book-cover/[[path]].js` sirve el original. Guardar ese original no elimina el coste de `/cdn-cgi/image/` aplicado después.
- El zoom tenía un `src` y `loading="eager"` dentro de un diálogo oculto. El primer cambio elimina esa solicitud inicial y asigna la imagen con el controlador existente al abrir el zoom. Conserva dimensiones, calidad, miniaturas y navegación.

Esta corrección acota una descarga innecesaria; no elimina todos los cobros de Images ni permite prometer un importe de ahorro. Los tipos facturados tampoco prueban que todo el consumo de la cuenta provenga de esta web.

## Solución permanente recomendada

Generar las versiones optimizadas una vez por hash del master y versión de la receta, y guardarlas como objetos permanentes en R2. Servir esos archivos directamente en el `srcset`, sin envolverlos nuevamente en `/cdn-cgi/image/`. Se conservan los originales para zoom, SEO/feeds y recuperación; no se reescribe ni se degrada el master.

La clave de cada archivo debe incluir hash del master, ancho, formato, calidad, fit y versión de la receta. Un cambio de portada genera otras claves; visitas nuevas, purga de caché o cambio de mes no regeneran los mismos archivos. No aumentar fuentes pequeñas artificialmente ni modificar encuadres existentes.

### Implementación verificable

1. Medir dimensiones y peso de una muestra representativa de masters: verticales, horizontales, tapas con letra chica y galerías. Registrar comparación visual y bytes antes/después.
2. Preparar versiones con un proceso offline (por ejemplo Sharp) o un escritor controlado que use Images sólo para nuevas recetas/masters. Preservar los tamaños necesarios para `sizes` y pantallas de alta densidad. Publicar por lotes limitados con presupuesto explícito de generación inicial.
3. Mantener un manifiesto de derivados separado y el mismo contrato de lectura/escritura: Pages sólo lee; un escritor controlado publica. La ausencia/fallo de un derivado debe servir el original de forma explícita, sin transformación de pago silenciosa ni pérdida de la imagen.
4. Servir URLs versionadas por hash con caché immutable, Content-Type real y `srcset` correspondiente a cada versión. Regenerar sólo por hash/receta nuevos, no con cada cron ni con cada visita. Evitar que una ruta pública con parámetros arbitrarios dispare generación pagada.
5. Comparar catálogo, ficha, zoom, encuadres especiales y galerías en Preview, móvil y desktop, con fuentes de distinta resolución. Verificar que ninguna ruta de imagen migrada envuelva los archivos en `/cdn-cgi/image/`, y que el segundo recorrido no genere nuevos derivados.
6. Migrar gradualmente tras validar cobertura, mantener rollback y después medir Images Transformed en el siguiente ciclo. R2, operaciones y CPU pueden seguir generando costes; no prometer coste total cero.

Las suscripciones se revisan después de comprobar dependencias y migración. La entrega directa desde R2 evita este tipo de transformaciones repetidas, pero el ahorro efectivo exige verificar todas las rutas y el panel del ciclo siguiente. No basta prolongar TTL: Cloudflare factura la primera solicitud mensual de la variante incluso si estaba en caché.

## Estado

Primera corrección preparada: zoom bajo demanda con prueba de controlador (entrada sin solicitud, apertura, siguiente/anterior, cierre y reapertura de la imagen elegida). La arquitectura de derivados permanentes queda especificada, todavía no implementada ni desplegada. No se modifica producción ni suscripciones desde esta revisión.
