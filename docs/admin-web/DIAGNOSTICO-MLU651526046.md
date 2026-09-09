# Ficha MLU651526046: comprobación real de imagen para Google

Comprobación de sólo lectura del 9 de septiembre de 2026, 10:48 UTC.
URL aportada por Seba:
https://www.amadolibros.com/libro/MLU651526046/big-english-1-british-pupil-s-book-pearson

## Evidencia

- Run: https://github.com/trexxeseba/amadolibros-web/actions/runs/34342149786
- Commit del diagnóstico: b60bd976c9bf5dfaa7e725fa3dcb7cdc98b55fd9.
- HTML: HTTP 200, 7.672 ms; un Product/Book con SKU correcto y Offer.
- JSON-LD válido; propiedad Product.image ausente.
- La imagen principal visible y og:image conducen a /book-cover/MLU651526046/cover.jpg.
- Esa portada respondió HTTP 200, image/jpeg, x-cover-source=r2-production.
- Dimensiones leídas de los bytes: **426 × 500**, 59.342 bytes.
- Primera lectura con redirección de imagen: 7.297 ms; dos lecturas posteriores: 14 y 10 ms. Son lecturas puntuales desde un runner, no una medición representativa de la experiencia de todos los clientes.

## Interpretación y límites

La ausencia de Product.image está confirmada en Producción en esta ficha.
La portada principal no cumple el umbral interno de 500 en ambos lados.
Por tanto, no corresponde descartar el tamaño como explicación ni atribuir este caso únicamente a una lectura fallida del índice.
El código también elimina la imagen cuando no puede leer el índice; es un riesgo adicional, sin evidencia de que haya causado esta respuesta concreta.

No se consultó Search Console ni se reprodujo el rastreo histórico de Google. No se conocen el número total de afectados ni el estado de validación de Google.
Se inspeccionaron HTML y bytes de imagen; no se ejecutó una prueba visual de navegador en este diagnóstico.
La auditoría comercial y el monitor Checkly existentes todavía no comprueban Product.image. Un resultado verde de esos controles no valida este campo.

Corrección recomendada: conservar una foto real y accesible como alternativa cuando la lista de imágenes seleccionadas quede vacía, manteniendo la preferencia por alta calidad; incorporar detección explícita de Product.image ausente y su recuperación.
Corrección de la tienda y nuevo control todavía pendientes. Este diagnóstico no modifica la tienda, el receptor ni los monitores activos.
