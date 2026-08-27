# ML-DUPLICATE-ORIGIN-AUDIT-1 — evidencia 2026-08-22

Objetivo: medir cuánto de la aparente duplicación del catálogo web proviene del patrón de Mercado Libre **publicación común + publicación de Catálogo**. Este documento es sólo evidencia. No autoriza `rel=canonical`, redirects, exclusiones de sitemap ni cambios en Mercado Libre.

## Snapshot auditado

Artifact `seo-baseline-public-2026-08-08` regenerado por el workflow `SEO baseline public audit` sobre el head de PR #213.

- generado: `2026-08-22T01:07:05.667Z`;
- `catalog.json`: 7.086 listings activos con stock;
- active-index: 7.103;
- paused-index: 10.096;
- grupos con ISBN repetido: 3.136;
- listings dentro de esos grupos: 6.283;
- `same_book` histórico: 209;
- `isbn_inconsistent` histórico: 2.927.

## Hallazgo principal

Sobre los **3.136 grupos con ISBN repetido**:

- 3.118 (`99,43%`) son `ml_common_plus_catalog`: todos los miembros comparten un único `catalog_product_id` y el grupo contiene al menos una publicación común (`catalog_listing=false`) y una de Catálogo (`catalog_listing=true`);
- 1 grupo (`0,03%`) comparte un único `catalog_product_id` pero no presenta la mezcla common/catalog;
- 8 grupos son `bibliographic_only` (sin identidad de Catálogo ML observable);
- 5 tienen `catalog_product_id` sólo en parte de los miembros;
- 4 tienen más de un `catalog_product_id` y se marcan como conflicto.

En total, el `catalog_product_id` explica estructuralmente 3.119/3.136 grupos (`99,46%`), pero **esto no significa que todos sean seguros para canonical**. La identidad de Catálogo ML es una señal fuerte de origen, no una autorización SEO automática.

## Subconjunto estricto `same_book`

Los 209 grupos que el baseline histórico ya clasificaba `same_book` son, sin excepción:

- `ml_common_plus_catalog`: **209/209 (100%)**;
- un solo `catalog_product_id` por grupo;
- mezcla `catalog_listing=false` + `catalog_listing=true`.

Al aplicar además los gates del detector #208 sobre los campos completos disponibles (condición + autor + edición/idioma/formato):

- **177 grupos** quedan sin motivos de revisión/rechazo y son candidatos de alta confianza estructural;
- **26 grupos** requieren revisión humana;
- **6 grupos** se rechazan por conflicto de idioma.

Motivos de revisión dentro de los 26:

- 19 por autor genérico;
- 4 por idioma presente sólo en parte del grupo;
- 3 por autor faltante (2 de ellos además con formato parcial);
- 1 por formato parcial adicional.

Los 177 candidatos de alta confianza siguen siendo sólo candidatos de auditoría. La selección del representante y la salud SEO del destino deben verificarse antes de aplicar cualquier canonical.

## Tres pares ya priorizados por GSC

### Headway Elementary 5th Edition Audio CD

- ISBN `9780194527552`;
- MLU `MLU715787398` / `MLU648794507`;
- ambos `active`, stock 2, condición `new`;
- mismo `catalog_product_id`: `MLU22050086`;
- uno `catalog_listing=true`, otro `false`;
- mismo título y autor (`Soars, John`);
- idioma en ambos: `Inglés Internacional`;
- sin conflicto de edición/formato observable.

Estado estructural: **alta confianza**.

### Obesidad — Virginia Busnelli

- ISBN `9789500217262`;
- MLU `MLU1067876690` / `MLU677997343`;
- ambos `active`, stock 3, condición `new`;
- mismo `catalog_product_id`: `MLU67241264`;
- uno `catalog_listing=true`, otro `false`;
- mismo título y autor (`Virginia Busnelli`);
- idioma en ambos: `Español`;
- sin conflicto de edición/formato observable.

Estado estructural: **alta confianza**.

### Memento Mori — Recuerda Tu Muerte

- ISBN `9798294067946`;
- MLU `MLU834746174` / `MLU1420573720`;
- ambos `active`, stock 1, condición `new`;
- mismo `catalog_product_id`: `MLU71971140`;
- uno `catalog_listing=true`, otro `false`;
- mismo título;
- autor en ambos: `Varios autores`;
- idioma en ambos: `Español`.

Estado estructural: **manual_review** por `author_generic`, manteniendo el gate conservador de #208.

## Por qué no conviene convertir `catalog_product_id` en una llave absoluta

Hay al menos un contraejemplo relevante: el grupo ISBN `9781234567897` contiene tres libros usados claramente distintos pero todos asociados a `catalog_product_id=MLU21109168`. Esto demuestra que `catalog_product_id` puede estar sucio o reutilizado incorrectamente en publicaciones comunes.

Por eso la regla segura sigue siendo combinar señales:

1. ISBN válido idéntico;
2. condición compatible;
3. identidad ML consistente;
4. título/autor y campos bibliográficos sin contradicciones críticas;
5. destino SEO saludable antes de canonical.

## Qué explica el volumen de `isbn_inconsistent`

Dentro de los 3.118 grupos `ml_common_plus_catalog`, 2.909 fueron históricamente `isbn_inconsistent` porque el título y/o autor normalizado no coinciden de forma exacta.

Desglose de esos 2.909:

- 2.166: título distinto, autor igual;
- 20: título igual, autor distinto;
- 723: título y autor distintos.

Además:

- sólo 1 grupo presenta conflicto de condición;
- 92 presentan diferencias de idioma declarado;
- 0 presentan conflicto de formato observable;
- 0 presentan conflicto de edición observable.

La mayoría son pares simples: 3.114/3.118 grupos `ml_common_plus_catalog` contienen exactamente dos listings, típicamente una publicación común y una publicación de Catálogo.

Esto confirma la hipótesis de origen — Mercado Libre está generando gran parte de la duplicación aparente — pero no justifica consolidar automáticamente los 2.909 grupos textualmente inconsistentes. Esos grupos deben estudiarse con reglas separadas antes de cualquier canonical.

## Conclusión operativa

La hipótesis queda **confirmada con evidencia fuerte**: casi todos los ISBN repetidos observados provienen del patrón de identidad de Catálogo ML, y el 100% del subconjunto histórico `same_book` es common+catalog.

Siguiente paso seguro:

- mantener #213 como audit-only;
- usar los 177 grupos de alta confianza como universo de estudio;
- mantener #208 conservador;
- preparar, en un lote separado y sujeto a aprobación, un piloto reversible muy pequeño (por ejemplo Headway + Obesidad) donde el destino se elige también por salud SEO/indexable, no sólo por stock/precio;
- 301 sigue fuera de alcance.
