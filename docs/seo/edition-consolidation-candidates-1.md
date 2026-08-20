# SEO-EDITION-CONSOLIDATION-CANDIDATES-1

Objetivo: detectar pares/grupos de publicaciones activas que podrían representar la misma edición, sin aplicar todavía `rel=canonical`, 301 ni exclusiones de sitemap.

## Regla conservadora

Un grupo sólo queda como `canonical_candidate` cuando todos sus miembros cumplen simultáneamente:

- publicación activa con stock;
- ISBN válido y normalizado al mismo GTIN;
- misma condición (`new` o `used`);
- título normalizado idéntico;
- autor normalizado presente e idéntico.

Si falta autor o condición, el grupo queda `manual_review`. Si título o autor entran en conflicto, queda `do_not_consolidate`.

El detector no usa similitud semántica, no corrige ISBN y no agrupa ítems sin ISBN válido.

## Representante

Dentro de un grupo de alta confianza se propone un representante determinista:

1. mayor stock;
2. a igualdad de stock, menor precio válido;
3. a igualdad, menor ID MLU.

Esto mantiene el criterio alineado con la lógica comercial ya usada en el feed de Merchant, sin tocar todavía las fichas.

## Ejecución

```bash
node scripts/seo/edition-consolidation-candidates.mjs catalog.json report.json
```

El reporte incluye estadísticas, grupos, representante propuesto, fuentes candidatas y motivos de revisión/rechazo. El resultado es determinista para el mismo input.

## No incluido

- no cambia canonicals;
- no crea redirects;
- no modifica sitemap;
- no toca Mercado Libre;
- no modifica precio, stock, carrito ni checkout.

El paso siguiente, sujeto a aprobación, es correr este detector sobre un snapshot fresco del catálogo, revisar manualmente un piloto pequeño y recién entonces diseñar la capa reversible de canonical.
