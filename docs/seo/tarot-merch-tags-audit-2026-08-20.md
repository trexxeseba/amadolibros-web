# TAROT-MERCH-TAGS-1 — auditoría forense del inventario Tarot & Oráculos

Fecha del dictamen: 2026-08-20
Generado por: `scripts/seo/generate-tarot-merch-tags.mjs`
Artefacto: `functions/_shared/tarot-merch-tags.js`
Fuentes: `catalog.json` (activos, en vivo) + índice pausado completo actual y anterior (por encargo, en vivo, R2)

Este lote **no crea ni modifica ninguna página**. Es exclusivamente la capa de clasificación que va a consumir `TAROT-HUB-MERCH-1` (renderizado de `/libros/esoterismo-tarot`) y `TAROT-FINDER-1` (selector interactivo).

## Regla semántica fundamental (verificada en el resultado real)

Lenormand no es tarot. Kipper no es tarot. Oráculo no es tarot. El clasificador revisa Lenormand y Kipper **antes** que tarot/oráculo específicamente porque muchos vendedores de MercadoLibre etiquetan sus mazos Lenormand con "tarot" y "oráculo" también, por tema de búsqueda — sin esa prioridad, esos mazos quedarían mal clasificados. Ejemplos reales que confirman que la regla funciona:

| Título real | primary_type asignado |
|---|---|
| "Tarot De Madame Lenormand (libro + Cartas) Tarot" | `lenormand` (no `tarot`) |
| "Golden Lenormand Oracle Oráculo Tarot Oro" | `lenormand` (no `tarot` ni `oraculo`) |
| "Oráculo Thelema Lenormand (cartas, Tarot, Adivinación)" | `lenormand` |
| "El Tarot Kipper Combo" | `kipper` (no `tarot`) |

## 1–11. Inventario forense — conteos exactos

| # | Métrica | Valor |
|---|---|---:|
| 1 | Total bruto de MLU relacionados (activos + por encargo) | **847** (327 activos + 520 por encargo) |
| 2 | Productos únicos tras deduplicar | **527** |
| 3 | Tarots (`primary_type=tarot`) | **367** |
| 4 | Oráculos (`primary_type=oraculo`) | **133** |
| 5 | Lenormand | **22** |
| 6 | Kipper | **2** |
| 7 | Rider-Waite-Smith (`deck_family`, sólo dentro de tarot) | **25** |
| 8 | Marsella | **22** |
| 9 | Thoth | **5** |
| 10 | Mazo + guía/libro (`bundle=mazo_mas_guia`, sobre los 249 `format=mazo`) | **33** (216 son `solo_mazo`) |
| 11 | Idiomas | español **114** · inglés **42** · multilingüe **4** · desconocido **367** |

Desglose adicional por `format`: libro **86** · mazo **249** · desconocido **192** (36% — ver sección de límites metodológicos).

Desglose por `deck_family` (sólo aplica a tarot): Marsella 22, Rider-Waite-Smith 25, Thoth 5 — el resto (315 de 367 tarots) es tarot genérico sin un deck_family específico demostrable, que es lo esperable: no todo listado nombra la familia clásica del mazo.

## 12. Accesorios reales

**Cero.** La primera corrida detectó 17 "accesorios" que resultaron ser 100% falsos positivos — ver sección de hallazgos y correcciones abajo. Tras corregir la regla, ningún ítem del catálogo actual matchea de forma confiable un accesorio tarot-esotérico vendido por separado (tapete, bolsa, atril, soporte). Si en el futuro aparece inventario real de ese tipo, el clasificador ya está preparado para detectarlo — simplemente no hay evidencia hoy.

## 13. Top 20 marcas/editoriales/autores

Del campo `author` del catálogo (405 de 527 productos únicos lo tienen no vacío):

| # | Autor/marca | Productos |
|---|---|---:|
| 1 | Lo Scarabeo | 21 |
| 2 | Doreen Virtue | 12 |
| 3 | "AUTOR" (placeholder genérico, no un autor real) | 9 |
| 4 | "VV. AA." (varios autores) | 8 |
| 5 | Ciro Marchetti | 6 |
| 6 | Barbara Moore | 6 |
| 7 | "Anónimo" | 6 |
| 8 | Matt Hughes | 5 |
| 9 | Pietro Alligo | 4 |
| 10 | Marianne Costa | 4 |
| 11 | Pamela Colman Smith | 4 |
| 12 | Alana Fairchild | 4 |
| 13 | Isabelle Cerf | 4 |
| 14 | Colette Baron-Reid | 3 |
| 15 | Toni Carmine Salerno | 3 |
| 16 | Fabio Listrani | 3 |
| 17 | Antonella Castelli | 3 |
| 18 | Atanas Atanassov | 3 |
| 19 | Denise Linn | 2 |
| 20 | Virtue, Doreen (variante de escritura del #2 — mismo autor, distinto formato de nombre en origen) | 2 |

**Lo Scarabeo** (editorial italiana especializada en tarot) es, de lejos, la marca dominante — casi 4% de todo el universo único. Nota metodológica: "AUTOR"/"VV. AA."/"Anónimo" son placeholders de MercadoLibre, no autores reales — quedan en la tabla porque así están en el dato de origen, pero no deben tratarse como una marca real en ningún módulo de merchandising.

## 14. Ejemplos de falsos positivos descartados

La regla `KNOWN_FALSE_POSITIVE_RE` no encontró ningún caso real en el catálogo activo actual que necesitara excluirse explícitamente (0 de los candidatos brutos cayeron en ese filtro) — señal de que la red amplia (`CANDIDATE_RE`) ya es razonablemente precisa para este catálogo. La regla queda igual en el código como salvaguarda documentada, cubriendo patrones verificados como no-tarot en auditorías previas del catálogo general (cartas de San Valentín, naipes de truco, "destino manifiesto" como título de historia): ver tests `falsos positivos conocidos quedan fuera del universo candidato` en `functions/__tests__/tarot-merch-tags.test.js`.

**Un falso positivo real sí apareció y se corrigió durante esta auditoría** (no en el filtro de candidatos, sino en la clasificación de accesorios — ver sección siguiente).

## 15. 20 casos dudosos que quedan deliberadamente sin clasificación firme

Todos matchean `needs_review=true` por mencionar 2 o más sistemas distintos en el mismo título — la regla los deja así a propósito, en vez de forzar una elección:

1. "Tarot Para Manifestar Libro Oraculo Esoterismo"
2. "Q&k Light Seer's Oracle Tarot Cartas 78 Cartas, Tarot Cart"
3. "Tarot De Madame Lenormand (libro + Cartas) Tarot"
4. "Libro - Oraculo De Los Angeles - Miriam Colecchio Tarot"
5. "Pequeño Oraculo De Los Angeles Guarda Salerno Carmine Tarot"
6. "Rebecca Campbell - Trabaja Tu Luz Cartas Oraculo Tarot"
7. "Tarot Vidente De Luz Chris Anne Oráculo Mazo Light Seers"
8. "El Oraculo Lenormand Martina J Gabler"
9. "Tarot Psiquico Holland Oraculo+65 Cartas + Libro"
10. "La Lunologia - Boland Yasmin Tarot Oraculo"
11. "El Tarot De Cristal Elisabetta Trevisan Oraculo Unico"
12. "Oráculo Adivino De Sibilla Cartas Tarot"
13. "Cartas, Oráculo, Tarot: Cartas De Arquetipos"
14. "Oráculo, Cartas, Tarot: Ayuda Diaria De Los Ángeles Oráculo"
15. "Cartas, Tarot, Oráculo: Tarot Egipcio Kier"
16. "Cartas, Oráculo, Tarot: María Reina De Los Ángeles"
17. "Cartas Tarot: Los Sueños Encantados De Lenormand"
18. "Golden Lenormand Oracle Oráculo Tarot Oro"
19. "Cartas, Tarot, Oráculo, Pagan Lenormand"
20. "Cartas, Oráculo, Tarot De Las Diosas - María Caratti"

Total real de casos así: **110** (de los 262 `needs_review` totales). Los otros **152** quedan en revisión por el otro motivo: no se pudo determinar `format` (mazo vs. libro) con las señales de texto disponibles — ver ejemplos abajo.

## Oportunidades detectadas para TAROT-FINDER-1

Ejes que el clasificador ya resuelve con datos reales y que el selector puede usar como preguntas:

| Pregunta del finder | Eje ya calculado | Cobertura real |
|---|---|---|
| ¿Tarot, oráculo o Lenormand? | `primary_type` | 527/527 (100%, ninguno queda `desconocido` en el catálogo actual) |
| ¿Incluye guía? | `bundle` (`mazo_mas_guia` / `solo_mazo`) | sólo sobre los 249 con `format=mazo` |
| Idioma | `language` | 160/527 con dato real (30%) — mayoría `desconocido`, ver límite abajo |
| ¿Clásico (RWS/Marsella/Thoth) o contemporáneo? | `deck_family` | 52/367 tarots (14%) — el resto es tarot sin familia clásica identificada |
| Primer tarot / nivel | `level` | señal real disponible en muy pocos títulos — mayoría `desconocido`, honesto |

**No hay dato real y demostrable en el catálogo para "rango de precio como filtro temático" ni "regalo/coleccionista" como ejes de texto** — precio sí existe como campo numérico del catálogo (no es parte de este clasificador, es un campo ya presente en `catalog.json`) y puede usarse directo en el finder sin necesitar clasificación; "regalo" y "coleccionista" no tienen señal de texto confiable y no se inventó ningún tag para ellos — `edition_style=ilustrada_especial` es lo más cercano a "coleccionista" con evidencia real.

## Límites metodológicos (para que TAROT-HUB-MERCH-1 no los ignore)

1. **`format` desconocido en 192 productos (36%)** — mayormente títulos con patrón "Autor Apellido Título" (ej. "Ortega Tarot De Mantegna Sabiduría Arcana", "García Robles Tarot Sistémico Transgeneracional") que probablemente son libros por convención editorial, pero no tienen la palabra "libro"/"editorial" ni ningún signo de mazo demostrado en el título almacenado. Se decidió **no inferir por convención** — queda `desconocido` en vez de una adivinanza. Si se quiere cerrar este gap, el camino correcto es cruzar contra `catalog_product_id`/metadata de MercadoLibre si algún día es confiable, no ampliar más las reglas de texto.
2. **`language` desconocido en 367 de 527 (70%)** — `bibliographic` casi siempre es `null` en este catálogo para productos de tarot (son mercancía, no libros catalogados formalmente), y la mayoría de los títulos no declara el idioma explícitamente. Esperable, no es un bug.
3. **`is_restocked` = 0 en las 527 filas** — hay evidencia histórica real disponible (`restock_evidence_available: true`), pero la única comparación disponible en este momento es entre dos sincronizaciones separadas por ~2,5 horas del mismo día (18:06 y 20:37 UTC del 2026-08-20) — una ventana demasiado corta para que un ítem realmente vuelva de "pausado" a "activo". El mecanismo está probado y testeado (`detectRestockedIds`), pero para que `TAROT-HUB-MERCH-1` tenga un módulo "Volvió a estar disponible" con datos reales hace falta volver a correr este generador dentro de unos días/semanas, cuando exista una comparación día-a-día o semana-a-semana real.
4. **`is_new_arrival` = 5** — ventana de 30 días sobre `start_time`, campo real del catálogo. Bajo pero correcto: no hubo mucha alta reciente de tarot/oráculos en el último mes.

## Hallazgos y correcciones durante esta auditoría (transparencia del proceso)

Tres bugs reales se encontraron revisando ejemplos verdaderos del catálogo (no hipotéticos) y se corrigieron antes de generar el artefacto final — quedan documentados acá y bloqueados con tests de regresión:

1. **"estuche" mal clasificado como accesorio.** 16 de 17 "accesorios" de la primera corrida eran en realidad mazos empaquetados en caja ("Tarot Egipcio (estuche: 78 Cartas Y Libro)") — "estuche" describe el embalaje del propio mazo, no un accesorio vendido aparte. Se quitó de `ACCESSORY_RE`. Resultado tras la corrección: 0 accesorios reales detectados (ver punto 12).
2. **Libros con "cartas" en el título se clasificaban como mazo.** "Libro Las Piedras Ancestrales Oraculo, De Campbell, Rebecca" y títulos similares con el patrón real "De [Autor]. Editorial [Nombre]" no tenían ninguna señal de libro reconocida. Se agregaron `libro` y `editorial` como señales fuertes de libro, con prioridad sobre una mención suelta de "cartas" (que sigue existiendo en títulos de libros que hablan *sobre* las cartas).
3. **Mazos en inglés con "78 Cards" no se detectaban como mazo** (sólo se reconocía "cartas" en español). Se agregó `cards`/`deck` al inglés.

Antes → después de las tres correcciones: `format=desconocido` bajó de 339 a 192 (64% → 36% del universo), `needs_review` bajó de 376 a 262 (71% → 50%).
