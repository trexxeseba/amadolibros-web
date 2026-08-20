# SEO-PRODUCT-SCHEMA-1

Corrección semántica para fichas de libro sin una señal elegible de Product snippet.

- Si el JSON-LD declara `Product` + `Book` pero no contiene `offers`, `review` ni `aggregateRating`, se degrada a `Book`.
- No se inventan precios, disponibilidad, reseñas ni ratings.
- Las fichas vendibles con `Offer` real conservan `Product` + `Book`.
- Canonical, robots, sitemap, stock, checkout y Merchant quedan fuera de alcance.
