# Auditoría de experiencia de compra — 2026-09-26

Revisión página por página de amadolibros.com en producción, en celular (390 px) y en compu (1366 px), con la mirada de un ecommerce de librería. Las capturas se sacan con `scripts/ux/capture-screens.mjs` (workflow «UX — capturas de producción», solo lectura).

## Diagnóstico (ordenado por impacto en ventas)

1. **Cuatro estéticas distintas.** La portada es crema, con tipografía editorial y coral; el catálogo era negro con letra de sistema; la ficha, azul marino con links azules; el carrito, negro con serif. Al pasar de la portada al catálogo o a una ficha, se siente otra tienda y baja la confianza.
2. **En la ficha, en el celular, el precio y el botón de compra quedaban a dos pantallas.** La tapa ocupaba toda la primera pantalla.
3. **El botón «Agregar al carrito» parecía deshabilitado.** Era salmón claro al lado del verde intenso de WhatsApp, así que la acción secundaria pesaba más que la de comprar.
4. **En el catálogo, en el celular, el primer libro aparecía a mitad de la segunda pantalla.** Antes había buscador, desplegable, botón y pestañas apilados.
5. **Los títulos eran los de MercadoLibre**, por ejemplo «La Reina Descalza, De Ildefonso Falcones. Editorial Distribuciones Agapea - Libro». Eso cuesta leerlo y se corta en la tarjeta.
6. **El sello «Te llega hoy» dominaba cada tarjeta**, por encima del título y el precio.
7. **Publicaciones con imagen promocional en lugar de tapa.** Por ejemplo, un banner «Top 10 books… despacho a todo Chile» aparece primero en el catálogo, y la galería de algunas fichas mezcla fotos de otros libros y el logo. Esto hay que corregirlo en las publicaciones de MercadoLibre.

## Resuelto en este cambio

- **Ficha:** encabezado del mismo negro que el catálogo, links en terracota de la marca y fondo cálido.
- **Ficha:** en el celular la tapa queda contenida y centrada y las miniaturas van en una fila, así el precio sube.
- **Ficha:** «Agregar al carrito» pasa a ser la acción principal, sólida y de alto contraste. WhatsApp queda con contorno verde y MercadoLibre sigue tercero.
- **Catálogo:** títulos limpios en las tarjetas. Solo se recortan los sufijos comerciales («De Autor. Editorial X, Tapa Blanda»); la búsqueda y los links no cambian.
- **Catálogo:** en el celular, el buscador y el botón van en una sola fila y los desplegables se ocultan porque los temas ya están como botones. Las pestañas de disponibilidad son más compactas.
- **Catálogo:** el sello «Te llega hoy» es más chico dentro de las tarjetas.

## Próximos pasos recomendados

- **Encabezado y tipografía comunes** para portada, catálogo, ficha, temas y carrito: un solo componente con buscador, Temas, Pedir un libro y Carrito.
- **Tapas:** marcar y relegar las publicaciones cuya primera imagen no es la tapa; se puede detectar con la proporción de la imagen y un revisor visual.
- **Ficha:** botón de compra fijo abajo en el celular (precio + «Agregar al carrito») y reseña o sinopsis resumida antes de la descripción larga.
- **Catálogo:** orden por defecto que priorice libros con tapa real y stock, y un selector de orden visible (novedades, precio).
