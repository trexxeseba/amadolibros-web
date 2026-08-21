# TAROT-ACCESSORIES-OPPORTUNITY-AUDIT-1 — auditoría de solo lectura

Fecha: 2026-08-21
Alcance: sólo lectura sobre el catálogo real (activo + por encargo). No modifica nada, no crea ningún módulo nuevo.

## Resultado

**0 accesorios de tarot detectados con los criterios auditados en el catálogo actual.** (Conclusión operativa: no crear un módulo de Accesorios — ver sección final.)

Verificado por **dos vías independientes**, con resultado idéntico:

1. `functions/_shared/tarot-merch-tags.js` (TAROT-MERCH-TAGS-1): `primary_type === 'accesorio'` → **0** filas.
2. Barrido manual independiente sobre catálogo activo (7.090 ítems) + índice pausado (10.097 ítems) descargados en vivo el 2026-08-21, buscando términos de accesorio real (`tapete`, `paño`, `bolsa`, `atril`, `soporte`, `vela ritual`, `sahumerio`, `incensario`, `funda`, `caja de madera`, `journal`, `cuaderno`, `bitácora`) con límite de palabra, intersectados con vocabulario tarot-adyacente (`tarot`, `oráculo`, `lenormand`, `kipper`, `cartomancia`) → **0** coincidencias.

## Recordatorio metodológico (por qué el número es 0 y no un error)

`estuche` **no** cuenta como accesorio: describe el embalaje del propio mazo ("Tarot Egipcio (estuche: 78 Cartas Y Libro)"), no un accesorio vendido aparte. Este criterio ya se verificó y corrigió durante TAROT-MERCH-TAGS-1 — la primera corrida de ese clasificador había detectado 17 "accesorios" que resultaron ser 100% mazos en caja, no accesorios reales (ver `docs/seo/tarot-merch-tags-audit-2026-08-20.md`, sección "Hallazgos y correcciones").

## Falsos positivos descartados en esta corrida

El barrido amplio inicial (sin exigir adyacencia a tarot) encontró 2.567 coincidencias de términos como "fund-" (de "Fundamentos", "Fundación" — no "funda"), "bitácora" en contextos ajenos (psicoanálisis, escuela), etc. — ninguno relacionado con tarot. Ejemplos reales descartados:

| MLU | Título | Por qué se descarta |
|---|---|---|
| MLU612062955 | "Bitácora De Una Práctica Psicoanalítica Niños Adolescentes" | "bitácora" sin ningún vocabulario de tarot/oráculo en el título |
| MLU624261887 | "Señales De Vida Una Bitácora De Escuela — Colección Del Melo" | ídem, contexto literario/escolar |
| (múltiples) | Títulos con "Fundamentos", "Fundación" | coincidencia de substring con "funda" corregida exigiendo límite de palabra (`\bfunda\b`) |

Ninguno de estos entró al conteo final porque el criterio real exige **coincidencia con vocabulario tarot-adyacente en el mismo título** — no un accesorio genérico de la librería.

## Qué significa esto para el roadmap

No hay hoy inventario real para justificar un módulo "Accesorios" dentro del Universo Tarot ni una landing dedicada. Si en el futuro Amado Libros suma este tipo de producto (tapetes, bolsas, atriles), el clasificador de TAROT-MERCH-TAGS-1 ya está preparado para detectarlo automáticamente en la próxima regeneración — no hace falta ningún cambio de código, sólo que el inventario exista.
