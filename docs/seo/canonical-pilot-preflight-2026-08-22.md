# SEO-CANONICAL-PILOT-PREFLIGHT-1 — evidencia 2026-08-22

Objetivo: decidir si dos pares de publicaciones estructuralmente idénticas están suficientemente validados como para **proponer** un canonical reversible en un lote posterior y separado. Este documento NO implementa canonical, 301, cambios de sitemap ni runtime.

## Fuentes

- PR #213: auditoría de origen Mercado Libre y snapshot estructural fresco.
- Link graph audit generado 2026-08-22T01:07:05.619Z.
- GSC Search Analytics: 2026-07-23 → 2026-08-19.
- Google URL Inspection ejecutado 2026-08-22.
- On-page SEO live audit ejecutado 2026-08-22.

## Gate mínimo

Un par sólo puede quedar `ready_for_preview_canonical_proposal` cuando:

1. comparte ISBN válido;
2. origen ML = `ml_common_plus_catalog`;
3. comparte `catalog_product_id`;
4. condición compatible;
5. título + autor coinciden;
6. no hay conflicto de idioma;
7. destino propuesto responde 200, es indexable y self-canonical hoy;
8. destino está `Submitted and indexed` en Google;
9. destino no está huérfano en el grafo interno;
10. fuente responde 200, es indexable y self-canonical antes del experimento.

El script `scripts/seo/canonical-pilot-preflight.mjs` valida estos gates sobre la evidencia congelada. Pasar el gate **no autoriza producción**: sólo habilita presentar una propuesta de canonical en Preview.

## Resultado

### 1. Headway Elementary 5th Edition Audio CD

ISBN `9780194527552` — `catalog_product_id=MLU22050086`.

**Destino propuesto:** `MLU715787398` (publicación Catálogo ML).

**Fuente candidata:** `MLU648794507` (publicación común).

Evidencia:

- ambos activos, stock 2, condición `new`;
- mismo título y autor (`Soars, John`);
- mismo idioma (`Inglés Internacional`);
- ambos 200, indexables y self-canonical hoy;
- destino `MLU715787398`: Google URL Inspection = `PASS`, `Submitted and indexed`, último crawl 2026-08-11;
- fuente `MLU648794507`: `NEUTRAL`, `Duplicate, Google chose different canonical than user`, último crawl 2026-06-24;
- link graph: destino NO huérfano; fuente huérfana;
- Search Analytics: 1 impresión cada URL en 28 días para la query exacta, ambas en posición 8, sin clics.

**Dictamen:** `READY — Tier A`. Es el caso más limpio: Google ya está tratando la fuente como duplicada y la URL destino es la que conserva indexación + enlaces internos.

### 2. Obesidad — Virginia Busnelli

ISBN `9789500217262` — `catalog_product_id=MLU67241264`.

**Destino propuesto:** `MLU1067876690` (publicación común).

**Fuente candidata:** `MLU677997343` (publicación Catálogo ML).

Evidencia:

- ambos activos, stock 3, condición `new`;
- mismo título y autor (`Virginia Busnelli`);
- mismo idioma (`Español`);
- ambos 200, indexables, self-canonical y `Submitted and indexed`;
- destino `MLU1067876690`: último crawl 2026-08-11, 415 palabras, 19 links internos, 11 imágenes;
- fuente `MLU677997343`: último crawl 2026-06-23, 216 palabras, 16 links internos, 6 imágenes;
- link graph: destino NO huérfano; fuente huérfana;
- GSC 28 días: 2 impresiones por URL, 0 clics. Para la query exacta `obesidad virginia busnelli`, posición observada 101 en destino y 79 en fuente; además la fuente tuvo otra impresión reciente en posición 5 para una query no expuesta por Search Console.

**Dictamen:** `READY — Tier B / medir con más cuidado`. El destino propuesto tiene mejor arquitectura interna y contenido bastante más rico, pero las dos URLs siguen indexadas y la fuente mostró una señal reciente más fuerte aunque con muestra extremadamente chica. Si se prueba, el monitoreo post-cambio debe ser más estricto que en Headway.

## Orden recomendado del piloto

1. **Headway primero** — riesgo SEO mínimo dentro del universo auditado.
2. **Obesidad después**, sólo si Headway confirma que el mecanismo de canonical funciona como esperamos en Preview y no rompe ficha, schema, carrito ni indexabilidad del destino.

## Fuera de alcance

- no se cambia `rel=canonical` todavía;
- no se crea ningún 301;
- no se quita ninguna URL del sitemap;
- no se toca Mercado Libre;
- no se cambia stock/precio/carrito/checkout;
- no se extrapola a los 177 candidatos de alta confianza.

## Próximo gate

Un lote nuevo y explícitamente aprobado deberá implementar **sólo en Preview** el canonical de Headway fuente → destino, con rollback trivial, y verificar:

- destino 200 + indexable + self-canonical;
- fuente 200 + canonical al destino;
- Product/Book/Offer intactos;
- sitemap sin cambios en esa primera prueba;
- checkout/carrito sin cambios;
- Preview noindex global intacto;
- diff limitado a la resolución de canonical por MLU.

Producción sigue fuera de alcance hasta aprobación explícita.
