# SEO-DUPLICATE-REVIEW-1

Segunda capa reproducible sobre los grupos `byIsbn` ya clasificados como `same_book` por `scripts/seo/duplication-report.mjs`.

No cambia la clasificación histórica del baseline y no ejecuta redirects.

## Decisiones

- `no_consolidate`: hay condiciones comerciales distintas (`new` vs `used`, etc.).
- `review`: misma condición pero precio difiere >20%, medidas lineales comparables difieren >20%, peso >35%, o falta evidencia suficiente.
- `green_candidate`: condición completa e igual, precios dentro del umbral y al menos una medida comparable presente en todos los listings sin divergencias fuertes.

`green_candidate` significa candidato a revisión humana, nunca autorización automática de 301.

## Umbrales congelados

- precio: 20%
- alto/ancho/largo: 20%
- peso: 35%

Las medidas se normalizan a cm y gramos para comparar valores equivalentes expresados en unidades diferentes.

## Salida

El reporte conserva `groups.byIsbn` y `groups.byTitleAuthor` y agrega:

- `groups.strictSameBookReview`
- `summaries.strictSameBookReview`
- `methodology.strictReviewThresholds`

Cada candidato muestra lado a lado `condition`, `price` y `dimensions`, además de las razones de la clasificación.

## Identidad de catálogo Mercado Libre

El reporte conserva, cuando el origen las entrega:

- `catalog_listing`: distingue publicación de catálogo (`true`) de tradicional (`false`);
- `catalog_product_id`: identifica el producto de catálogo relacionado;
- `sameCatalogProduct`: verdadero sólo cuando todos los listings del grupo tienen el mismo `catalog_product_id`;
- `mixedTraditionalCatalog`: verdadero sólo cuando el grupo contiene al menos una publicación tradicional y una de catálogo con señales completas.

Estas señales aportan evidencia, pero no cambian por sí solas la decisión de consolidación. Si faltan, el reporte las marca como incompletas y no infiere valores.
