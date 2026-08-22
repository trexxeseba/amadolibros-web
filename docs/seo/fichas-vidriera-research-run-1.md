# FICHAS-VIDRIERA-2 — RESEARCH-RUN-1

Fecha: 2026-08-22

## Alcance

Este lote valida la tubería de investigación bibliográfica antes de publicar contenido generado en fichas.

La corrida es sólo lectura: catálogo público R2 -> fuentes externas -> motor de evidencia -> reporte. No escribe fichas, sitemap, canonical, R2, D1, KV, Worker ni Producción.

## Cohorte técnica

Se usan los primeros 12 ISBN `gsc-demand` de la cohorte SEO ya versionada, conservando el orden real de prioridad de Search Console.

La corrida validada cubrió:

- 12 ISBN seleccionados;
- 559 impresiones históricas GSC;
- 46 clics históricos GSC;
- catálogo vigente de 17.201 fichas consolidadas;
- 7.111 activas y 10.096 pausadas en el snapshot usado.

## Resultado de fuentes

### Google Books

- autenticación WIF/OAuth reutilizando la service account existente: PASS;
- 12/12 consultas HTTP: PASS;
- 4/12 ISBN con match exacto;
- 8/12 sin match;
- 0 errores HTTP.

No se necesita una API key nueva para esta tubería mientras el WIF existente siga emitiendo correctamente el token con scope Books.

### Open Library

- 12/12 ISBN consultados mediante un único batch de bajo volumen;
- 0/12 con match exacto;
- 0 errores HTTP.

Conclusión: en esta muestra de demanda, Open Library no aporta cobertura suficiente para actuar como segunda fuente masiva. No se debe aumentar agresivamente el uso del API público. Si Open Library vuelve a evaluarse a escala, debe hacerse mediante su Search API/bulk dumps conforme a sus guías actuales, no convirtiendo el API público en backend masivo.

## Clasificación real

Después del hardening de identidad:

- GREEN: 0;
- YELLOW: 2;
- RED: 10;
- auto-publicables: 0.

Los dos YELLOW son:

- `9789878675701` — El legado, Germán Beder;
- `9788416894864` — La jubilación: una nueva oportunidad, Bartolomé Freire Arteta.

Ambos cuentan con una fuente fuerte exacta y contenido suficiente para generar borrador, pero no para auto-publicar.

## Hallazgos del gate de identidad

La primera corrida reveló falsos conflictos por diferencias bibliográficas normales:

- `Beder, German` vs `Germán Beder`;
- `Freire Arteta, Bartolomé` vs `Bartolomé Freire Arteta`.

El comparador ahora tolera:

- diacríticos;
- orden apellido/nombre;
- autores compuestos con los mismos tokens;
- honoríficos comunes;
- título localizado o comercialmente adaptado cuando el ISBN es exacto y el autor coincide.

Sigue bloqueando diferencias materiales de autor y también un título divergente cuando la fuente exacta no aporta autor y todavía no existe otra fuente exacta que confirme un autor compatible.

Esto evita dos fallos opuestos: contaminación por homónimos y bloqueo permanente por una fuente incompleta. Una confirmación posterior de editorial/biblioteca puede neutralizar un mismatch de título de una fuente sin autor, pero una contradicción real de autor continúa en RED.

## Decisión

RESEARCH-RUN-1 demuestra que la infraestructura funciona y que el principal cuello de botella ya no es autenticación ni ejecución: es cobertura de evidencia.

No corresponde escalar todavía la generación editorial a miles con Google Books + Open Library solamente. El siguiente lote debe aumentar la segunda fuente real, priorizando fuentes con mejor cobertura para los ISBN que Amado Libros vende: editorial/distribuidor/catálogos bibliográficos verificables, siempre con revalidación de ISBN y trazabilidad de origen.

La generación visible de `De qué trata / Para quién es / 5 temas / Autor / Edición` sigue detrás del gate de evidencia. No publicar copy nuevo hasta que la cobertura y los tiers estén medidos en un lote mayor.
