# SEO-EDITION-CONSOLIDATION-1 — evidencia para piloto

Fecha: 2026-08-20

Este documento no autoriza redirects ni canonicals. Reúne evidencia histórica y de Search Console para decidir qué pares deben revalidarse contra el catálogo vigente antes de cualquier cambio indexable.

## Baseline estructural preservado (2026-08-08)

El artifact público `seo-baseline-public-2026-08-08` registró:

- 7.123 items activos analizados;
- 3.164 grupos con ISBN repetido;
- 6.341 listings dentro de esos grupos;
- sólo 211 grupos `same_book` bajo la regla estricta del audit;
- 2.953 grupos `isbn_inconsistent`.

Conclusión: compartir ISBN no basta para consolidar. La gran mayoría de los grupos por ISBN presentan diferencias de título/autor y deben rechazarse o pasar por revisión.

## Evidencia GSC actual de canibalización útil para priorizar

Ventana GSC: 2026-07-21 a 2026-08-17.

### Candidatos fuertes: misma obra en baseline + query dividida entre dos URLs

1. `Headway Elementary 5th Edition Audio CD`
   - ISBN histórico: `9780194527552`
   - MLU: `MLU648794507`, `MLU715787398`
   - baseline: `same_book`
   - query GSC `headway elementary 5th edition audio`: 2 impresiones, repartidas 1/1 entre ambas URLs, posición 8/8.

2. `Memento Mori - Recuerda Tu Muerte`
   - ISBN histórico: `9798294067946`
   - MLU: `MLU834746174`, `MLU1420573720`
   - baseline: `same_book`
   - query GSC `memento mori`: 2 impresiones, repartidas 1/1 entre ambas URLs.

3. `Obesidad — Virginia Busnelli`
   - ISBN histórico: `9789500217262`
   - MLU: `MLU1067876690`, `MLU677997343`
   - baseline: `same_book`
   - query GSC `obesidad virginia busnelli`: 2 impresiones, repartidas 1/1 entre ambas URLs.

Estos tres pares son buenos candidatos para la primera revalidación fresca porque combinan identidad estricta histórica y evidencia de que Google está repartiendo impresiones entre dos URLs.

## Contraejemplos que justifican el detector conservador

Los siguientes pares comparten ISBN en el baseline, pero fueron clasificados `isbn_inconsistent`; no deben consolidarse automáticamente aunque Search Console muestre dos URLs para la misma query:

- `Daat: El Conocimiento` — `MLU661209812` / `MLU660998018` — ISBN `9789874816016`;
- `Maase Bereshit` — `MLU635157654` / `MLU652668348` — ISBN `9789872360368`;
- `Estrategias de enseñanza` — `MLU631153278` / `MLU631813403` — ISBN `9789870602125`;
- `Anastasia` — `MLU679607330` / `MLU679658240` — ISBN `9788461615063`;
- `La Nobleza Negra` — `MLU690319456` / `MLU691609938` — ISBN `9798854798280`;
- `Sod 22` — `MLU628130108` / `MLU617694745` — ISBN `9789872360351`.

El detector nuevo debe mantener estos casos fuera de `canonical_candidate` salvo que una verificación posterior demuestre identidad completa con reglas más fuertes que el ISBN solo.

## Gate antes de canonical

Para cada candidato del piloto hay que volver a verificar, sobre snapshot fresco:

1. ambos MLU siguen activos y con stock;
2. ISBN válido idéntico;
3. misma condición;
4. título normalizado idéntico bajo la regla del detector;
5. autor normalizado idéntico y no genérico;
6. ninguna diferencia de edición, idioma, formato u otro atributo comercial disponible;
7. representante elegido de forma determinista;
8. la URL representante responde 200, indexable y con canonical propio.

Si cualquiera falla, no se canonicaliza.

## Alcance recomendado del piloto

- empezar por los 3 pares con evidencia GSC anterior;
- ampliar hasta 20–30 pares sólo después de correr el detector contra el snapshot vigente y revisar manualmente la muestra;
- canonical reversible primero;
- 301 queda fuera de este lote y sigue reservado a pares humano-verificados.
