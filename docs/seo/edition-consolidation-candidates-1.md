# SEO-EDITION-CONSOLIDATION-CANDIDATES-1

Objetivo: detectar pares/grupos de publicaciones activas que podrían representar la misma edición, sin aplicar todavía `rel=canonical`, 301 ni exclusiones de sitemap.

## Regla conservadora

Un grupo sólo queda como `canonical_candidate` cuando todos sus miembros cumplen simultáneamente:

- publicación activa con stock;
- ISBN válido y normalizado al mismo GTIN;
- misma condición (`new` o `used`);
- título normalizado idéntico;
- autor normalizado presente, idéntico y no genérico.

Autores como `Varios autores`, `VV. AA.`, `Anónimo`, `No aplica` o equivalentes ya no habilitan canonical automático aunque coincidan entre publicaciones: el grupo queda `manual_review` con motivo `author_generic`.

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

## Evidencia que justifica este diseño

El baseline reproducido del 2026-08-08 encontró 3.164 grupos por ISBN, pero sólo 211 `same_book` bajo la regla estricta y 2.953 `isbn_inconsistent`. Compartir ISBN, por sí solo, no autoriza una consolidación.

El workflow público volvió a correr el 2026-08-20 sobre el catálogo vigente (generado a las 23:47:33Z) y midió:

- 7.090 activos con stock;
- 3.137 grupos con ISBN repetido;
- 6.285 listings dentro de esos grupos;
- 209 grupos `same_book` bajo la regla estricta histórica;
- 2.928 grupos `isbn_inconsistent`.

La evidencia de Search Console del 2026-07-21 al 2026-08-17 muestra además consultas repartidas entre dos URLs en algunos pares históricamente `same_book`, por ejemplo Headway Elementary 5th Edition Audio CD, Memento Mori y Obesidad de Virginia Busnelli. La revalidación estructural fresca confirmó que los tres pares siguen activos con stock y permanecen `same_book` bajo el baseline histórico; sin embargo Memento Mori usa el autor genérico `Varios autores`, así que el detector nuevo debe degradarlo a `manual_review`, no a candidato automático.

El baseline histórico no contiene `condition`; por eso ni Headway ni Obesidad quedan autorizados para canonical todavía. La siguiente revalidación debe ejecutarse con el detector nuevo sobre un snapshot completo que incluya condición y el resto de los atributos disponibles.

También hay consultas repartidas sobre pares con el mismo ISBN pero identidad textual inconsistente, como Daat, Maase Bereshit y Estrategias de enseñanza; esos contraejemplos deben permanecer fuera de la automatización.

El detalle y los MLU están preservados en `docs/seo/edition-consolidation-pilot-evidence-2026-08-20.md`.

## No incluido

- no cambia canonicals;
- no crea redirects;
- no modifica sitemap;
- no toca Mercado Libre;
- no modifica precio, stock, carrito ni checkout.

## Siguiente gate

Antes de cualquier canonical:

1. correr este detector sobre un snapshot fresco y completo del catálogo;
2. confirmar `condition` y los demás atributos comerciales disponibles;
3. revisar manualmente un piloto pequeño;
4. comprobar que el representante sigue 200, indexable y con canonical propio;
5. aplicar primero canonical reversible;
6. reservar 301 para pares humano-verificados.

Producción no se toca en este PR.
