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
