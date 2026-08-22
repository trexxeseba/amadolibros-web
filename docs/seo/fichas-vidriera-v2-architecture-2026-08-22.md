# FICHAS-VIDRIERA-2 — arquitectura de enriquecimiento semántico masivo

Fecha: 2026-08-22

## Objetivo

Convertir miles de fichas de Amado Libros —tanto disponibles como por encargo— en páginas editoriales útiles para personas y buscadores, sin convertir la generación con IA en texto genérico o no verificable.

Este documento define la capa de evidencia previa. **No cambia HTML, canonical, robots, sitemap, checkout ni Producción.**

## Estado real del sistema que ya existe

### Fichas activas

`functions/_shared/showcase-ranking.js` tiene un límite configurado de hasta 3.000 fichas vidriera y `isShowcaseEligible()` exige hoy:

- ID MLU válido;
- título;
- `status === active`;
- stock > 0;
- precio > 0;
- moneda UYU;
- señales de libro.

Por diseño, una ficha pausada nunca entra en esa cohorte aunque tenga excelente contenido y demanda orgánica.

### Fichas por encargo

La cohorte SEO pausada versionada registra:

- límite: 3.000;
- 10.083 publicaciones pausadas en el snapshot que la generó;
- 5.060 ISBN únicos elegibles antes del corte;
- 130 fichas seleccionadas con demanda histórica de Search Console;
- 2.870 seleccionadas por calidad de catálogo;
- 0 fichas de fallback débil;
- 754 impresiones y 52 clics históricos dentro de la cohorte seleccionada.

Estas URLs ya tienen una base estructural suficientemente fuerte para dejar de tratarlas como simples páginas logísticas.

## Problema arquitectónico

Hoy `availability` y `editorial_quality` están acoplados de forma accidental:

- activo puede acceder al renderer de ficha vidriera;
- pausado puede ser indexable y tener demanda, pero no recibe el mismo enriquecimiento editorial automático.

FICHAS-VIDRIERA-2 separa ambos ejes:

```text
availability: active | by_request
editorial_tier: green | yellow | red
```

Una ficha `by_request + green` debe poder ser editorialmente más rica que una ficha `active + red`.

## Fuentes previstas

La investigación se ejecutará offline/batch, nunca durante una request de cliente.

Fuentes admisibles:

1. Mercado Libre / descripción real de la publicación;
2. editorial o sello editorial;
3. web oficial del autor cuando corresponda;
4. Google Books;
5. Open Library;
6. catálogos de bibliotecas confiables;
7. distribuidores;
8. referencias web secundarias como apoyo, nunca como única base automática.

Cada evidencia se conserva con su fuente. La IA redacta a partir del paquete de evidencia; no reemplaza la evidencia.

## Dos identidades distintas

### Identidad de edición

Datos como editorial, páginas, idioma, formato, año y edición sólo se aceptan automáticamente cuando la evidencia coincide con el ISBN exacto.

Una fuente sobre otra edición de la misma obra puede ayudar a explicar el contenido del libro, pero no puede cambiar los datos de la edición vendida.

### Identidad de obra

Para resumen, temas, público y contexto del autor se admite:

- ISBN exacto; o
- título + autor compatibles cuando se trata claramente de la misma obra.

Esto permite aprovechar conocimiento de la obra sin mezclar datos físicos de ediciones distintas.

## Tiers

### GREEN

Requisitos mínimos:

- ISBN válido de la ficha;
- dos familias de fuentes independientes con contenido sustantivo;
- al menos una fuente fuerte;
- sin contradicción de identidad.

Permite:

- generación automática de resumen;
- `Para quién es`;
- cinco temas principales cuando la evidencia los sostiene;
- contexto del autor;
- publicación automática del contenido generado después de validaciones estructurales.

### YELLOW

Una sola fuente fuerte o evidencia suficiente a nivel de obra.

Permite generación automática limitada, pero no auto-publicación semántica completa. Puede publicar datos concretos de edición sólo campo por campo cuando el ISBN exacto y la fuente fuerte los respaldan.

### RED

- evidencia insuficiente; o
- conflicto de identidad.

No genera contenido semántico automático.

La regla no es “si no sabemos, abandonamos”. La regla es **buscar más evidencia automáticamente** hasta mover la ficha a amarillo o verde cuando sea posible.

## Qué debe producir el generador

Artefacto versionado por ficha:

```json
{
  "product_id": "MLU...",
  "isbn": "978...",
  "availability": "active|by_request",
  "tier": "green|yellow|red",
  "sources": [],
  "summary": "...",
  "audience": "...",
  "topics": ["..."],
  "author_context": "...",
  "edition_facts": {},
  "generated_at": "...",
  "generator_version": "..."
}
```

El renderer sólo consume un artefacto ya validado. No llama a Google Books, Open Library, buscadores ni modelos de IA durante la carga de una ficha.

## Orden de despliegue propuesto

### FASE A — evidencia y generación offline

1. motor de confianza (este lote);
2. conectores de investigación por ISBN/obra;
3. caché/versionado de evidencia;
4. generador de contenido estructurado;
5. auditor que rechaza contradicciones, duplicación y texto demasiado genérico.

### FASE B — primera cohorte masiva

Prioridad:

1. las 130 fichas por encargo con demanda GSC;
2. activas con demanda GSC y ficha vidriera existente;
3. resto de la cohorte activa elegible;
4. 2.870 pausadas seleccionadas por calidad.

No es un piloto manual de un solo libro. La arquitectura se diseña para miles; las cohortes sólo limitan el radio de despliegue y permiten medir causalidad.

### FASE C — expansión

Ampliar según tasa real de `green` y resultados de Google:

- 3.000 activas + 3.000 por encargo como primera superficie estructural;
- después 10.000+ si la evidencia y la indexación lo justifican.

## Render deseado

Orden editorial recomendado en ficha:

1. título / autor / portada;
2. `De qué trata`;
3. `Para quién es`;
4. `5 temas principales`;
5. `Sobre el autor`;
6. `Ficha de esta edición`;
7. bloque comercial.

En fichas por encargo, el bloque comercial debe ser compacto y no tapar el contenido editorial.

## Medición SEO obligatoria

Cada cohorte debe registrar antes/después:

- indexación;
- impresiones;
- consultas nuevas;
- posición media;
- CTR;
- clics;
- sesiones orgánicas;
- WhatsApp / aviso / carrito cuando aplique.

Ventanas: 14, 28 y 56 días.

No se debe atribuir automáticamente un cambio de ranking a la generación; se compara por cohortes y se conserva baseline.

## Fuera de alcance de este lote

- llamadas reales a fuentes externas;
- uso de una API de IA;
- cambios visibles en ficha;
- cambio de copy de encargo;
- eliminación de placas promocionales de galerías;
- canonical/redirect/sitemap;
- Producción.

Esos cambios deben ir en lotes separados para mantener atribución y rollback claros.
