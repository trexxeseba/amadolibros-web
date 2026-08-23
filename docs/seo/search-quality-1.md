# SEARCH-QUALITY-1

Objetivo: medir la calidad del buscador actual de Amado Libros antes de comprar o migrar a un motor externo.

## Hipótesis

El catálogo actual (~miles de libros) no necesita automáticamente Algolia. Primero hay que separar fallos de contenido/datos de fallos reales de recuperación: typo tolerance, sinónimos, abreviaturas, orden de palabras, acentos e intención.

## Gate

1. Ejecutar 20 consultas comerciales representativas contra Producción, read-only.
2. Guardar top 5 y tasa de 0 resultados por clase de intención.
3. Si los fallos se concentran en sinónimos/typos y pueden resolverse con una capa local pequeña y testeable, probarla en un PR separado.
4. Sólo comparar Algolia / Typesense / Meilisearch cuando el baseline demuestre una brecha que justifique servicio externo.

Este lote no cambia ranking, UX, catálogo ni Producción.
