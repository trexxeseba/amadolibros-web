# Limpieza de Esoterismo y Tarot: primera tanda

Solicitud de Seba: reclasificar los diez títulos de las capturas y crear subcategorías cuando hagan falta. Base inicial: main, `9bd89c29da40b2f2c7e52709960b033c49d7876c`. Actualizado sobre `f5079498285b9f11eade0ac82ff518229eb24deb` para conservar la corrección concurrente de ISBN/GTIN (#314).

| Producto | MLU | Ubicación |
| --- | --- | --- |
| El Cristo interior | MLU661851377 | Religión y espiritualidad > Espiritualidad |
| Cielo tiene su luna | MLU643087668 | Infantil y juvenil > Pubertad y educación menstrual; también Tarot y oráculos |
| El poder de la Kabbalah | MLU643758459 | Esoterismo > Cábala y Kabbalah (confirmada) |
| Pedro y la magia del pensamiento | MLU698362131 | Infantil y juvenil > Actividades y aprendizaje |
| Sefer Yetzirah | MLU646991953 | Esoterismo > Cábala y Kabbalah (confirmada) |
| El camino del kabbalista | MLU650471127 | Esoterismo > Cábala y Kabbalah (confirmada) |
| Mi maleta de yoga | MLU706775946 | Infantil y juvenil > Actividades y aprendizaje |
| Anatomía del espíritu | MLU669972586 | Esoterismo > Espiritualidad y energía |
| La magia de Daniela | MLU477509991 | Infantil y juvenil > Pubertad y educación menstrual |
| El yoga de Jesús | MLU613405055 | Religión y espiritualidad > Espiritualidad |

Se incluye MLU669963610, duplicado de Cielo tiene su luna identificado por ISBN 9789877782363 en el artefacto existente. La edición incluye libro ilustrado y cartas oráculo: se corrige el formato para retirarla del bloque de libros de estudio. Cábala ya existía; se agregan únicamente Pubertad y educación menstrual y Espiritualidad y energía.

Las correcciones manuales ganan al clasificador en futuras generaciones. El artefacto público conserva los 17.195 IDs, con ocho cambios de rutas (siete títulos y el duplicado); los otros tres títulos ya estaban bien clasificados. No se ejecuta una reclasificación global. Los contadores se calculan por producto y categoría, sin duplicar las categorías secundarias.

Se agregan accesos a subcategorías en las páginas de Esoterismo y Tarot e Infantil y juvenil usando los filtros existentes de /catalogo. No se crean URLs SEO indexables, ni se cambian títulos, H1, slugs, autorías, precios, stock o descripciones comerciales. El formato de Cielo tiene su luna se corrige tanto en la fuente generadora como en el artefacto de merchandising existente.

## Evidencia de contenido

Se revisaron las descripciones de las diez fichas públicas el 12/09/2026. Las rutas se identifican por los MLU de la tabla en `https://www.amadolibros.com/libro/MLU.../`.

- [El Cristo interior](https://www.amadolibros.com/libro/MLU661851377/javier-melloni-el-cristo-interior-teologia-y-meditacion): espiritualidad cristiana y contemplación.
- [Cielo tiene su luna](https://www.amadolibros.com/libro/MLU643087668/primera-menstruacion-cielo-tiene-su-luna-libro-oraculo): primera menstruación, libro y cartas de introspección. [Composición del conjunto corroborada](https://saberesciclicos.empretienda.com.ar/libros/para-ninas-y-ninxs/cielo-tiene-su-luna-con-mazo-de-carta-oraculo-ma-eugenia-ortega).
- [El poder de la Kabbalah](https://www.amadolibros.com/libro/MLU643758459/el-poder-de-la-kabbalah-rav-berg-cabala).
- [Pedro y la magia del pensamiento](https://www.amadolibros.com/libro/MLU698362131/pedro-y-la-magia-del-pensamiento-pensamiento-critico): pensamiento crítico para lectores jóvenes.
- [Sefer Yetzirah](https://www.amadolibros.com/libro/MLU646991953/sefer-yetzirah-el-libro-de-la-creacion-cabala-kabbalah).
- [El camino del kabbalista](https://www.amadolibros.com/libro/MLU650471127/el-camino-del-kabbalista-de-yehuda-berg-editorial-kabbalah-p).
- [Mi maleta de yoga](https://www.amadolibros.com/libro/MLU706775946/recurso-didactico-mi-maleta-de-yoga-ejercicios-y-relajacion): libro y actividades infantiles.
- [Anatomía del espíritu](https://www.amadolibros.com/libro/MLU669972586/anatomia-del-espiritu-de-la-curacion-del-cuerpo-llega-a-trav): chakras y tradiciones espirituales. Clasificar el contenido no valida sus afirmaciones sobre salud.
- [La magia de Daniela](https://www.amadolibros.com/libro/MLU477509991/la-magia-de-daniela-un-libro-para-entender-la-menstruacion): educación menstrual.
- [El yoga de Jesús](https://www.amadolibros.com/libro/MLU613405055/libro-el-yoga-de-jesus-paramahansa-yogananda): interpretación espiritual de los Evangelios desde el yoga.

## Verificación

La prueba `functions/__tests__/esoterismo-cleanup.test.js` comprueba la permanencia de las correcciones, los contadores, la pertenencia de los diez títulos a las páginas renderizadas y el formato del oráculo. Las suites existentes cubren clasificación, rutas, navegación, merchandising y fichas.

## Ampliación: Cábala Uruguay y entrega visible

Pedido explícito de Seba: página de Kabbalah para Uruguay y distintivo literal «Te llega hoy».

- Nueva landing `/libros/esoterismo-tarot/cabala-kabbalah`, alimentada por la subcategoría existente. Tiene título, H1, descripción, canonical, breadcrumbs, guía de compra y entrada automática en el sitemap de categorías. Se enlaza desde Esoterismo y la navegación de categorías.
- Un distintivo compartido muestra «Te llega hoy» y «Montevideo» en los productos activos con stock de portada, catálogo, categorías y ficha. No aparece en productos por encargo o sin stock. Es un mensaje comercial fijo solicitado por el dueño; no calcula horario de corte, días hábiles ni disponibilidad de cadetería. No cambia las reglas de envío, checkout ni datos estructurados.
- Los estilos se incluyen una sola vez por página, también en la portada Astro.
- La portada productiva usa HomeV2Topics y HomeV2Shelf: allí se incorporan los tres accesos específicos y el sello en las siete fichas disponibles. Se conservan también los componentes anteriores para sus usos existentes.
- Tras recibir «LISTO», se revisaron 220 publicaciones (incluidos duplicados y ediciones), con 170 cambios de rutas respecto de la primera tanda. El detalle antes/después está en `esoterismo-curation-2026-09-12.json`. Se conservan los 17.195 IDs públicos.
- Las correcciones de la primera tanda se conservan. La ampliación queda en la misma PR Draft, sin merge ni publicación productiva.

## Tanda completa y navegación

- Cuatro accesos visibles: mazos de tarot, mazos de oráculo, libros de tarot/oráculos y libros de esoterismo. Las tres nuevas selecciones complementan la página de mazos existente.
- Nueva categoría Juegos y actividades, con acceso desde la portada: incluye Mi maleta de yoga, El juego del ahora, Magic Rabbit y STOP. Los recursos infantiles conservan un acceso secundario por edad.
- Constelaciones familiares queda dentro de Desarrollo personal, con Hellinger, Siegfried Essen y otros títulos explícitos. Principios místicos de Thomas Hübl se incluye por instrucción expresa de Seba como lectura complementaria, conservando además Espiritualidad. Tarot sistémico transgeneracional se puede encontrar desde ambas materias.
- Yoga y meditación sale de la mezcla de esoterismo. Se agregan las divisiones temáticas requeridas por la tanda, manteniendo Sufismo y Cábala.
- 27 publicaciones de tarot/oráculos reciben una corrección persistente de formato y sistema. Los conjuntos de mazo y libro revisados no figuran como libros de estudio. No se infieren idiomas, cantidades de cartas ni contenidos desconocidos.
- Las tarjetas de Alma y Frin (MLU697305757) y Deleuze y la brujería (MLU706573878) amplían el encuadre en 1,65× y 1,72× respectivamente, conservando la proporción. Se aplica a tarjetas de portada, catálogo y categorías. Los archivos originales y las galerías no se editan.

Fuentes editoriales consultadas para los casos ambiguos:

- https://almalepik.com/nuestro-catalogo/ — Thomas Hübl y Bert Hellinger; la proximidad comercial no convierte Principios místicos en un manual técnico de constelaciones.
- https://blume.net/naturaleza/2260-la-magia-de-los-hongos-9788419094834.html — historia natural y cultural de hongos.
- https://www.lascuarentaeditorial.com.ar/productos/deleuze-y-la-brujeria-de-mark-fisher-y-matt-lee-digital/ — ensayos filosóficos de Matt Lee y Mark Fisher.
- https://www.editorialsaban.com.ar/productos/amor-en-magdala-mario-saban/ — bitácora espiritual, con acceso secundario a Cábala.
- https://www.editorialkairos.com/catalogo/p/el-juego-del-ahora — juego de cartas didácticas.

Los títulos y descripciones originales de producto no se reescriben. La categorización describe la materia de las obras sin validar afirmaciones sobrenaturales ni terapéuticas.
