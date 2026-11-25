# Regalos, galerías y avisos de stock

## Cambio visible

- Regalos ofrece Agregar al carrito con el mismo controlador de las fichas. El segundo clic abre el carrito sin duplicar la unidad. WhatsApp queda disponible para consultas y dedicatorias.
- Solo libros activos, con unidades enteras disponibles, precio positivo y moneda UYU tienen botón de compra. Precio y stock se vuelven a validar en el servidor por el flujo existente del carrito.
- Avisame cuando llegue usa las mismas reglas de contacto en la ficha y en la API. Letras mezcladas con teléfonos y correos incompletos se rechazan antes de CAPTCHA, catálogo y base. Corregir el campo limpia el error; se conservan los datos si falla el envío.
- La galería conserva el filtro exacto de imágenes revisadas y suma una comparación visual para reconocer copias recomprimidas de carteles conocidos. Las coincidencias se quitan de miniaturas, imagen principal y zoom; si no queda ninguna foto, se muestra un mensaje de imagen no disponible.

## Filtro conservador

Se comparan proporciones, huella perceptual de luminancia de 32 × 32 y distribución de colores en 4 × 4 celdas. Se requieren todas las condiciones: proporciones dentro de aproximadamente 6 %, distancia Hamming hasta 6 bits y error de color RMS hasta 16. No es un clasificador general ni borra imágenes del catálogo.

Las 14 referencias visuales provienen de fotos ya identificadas y revisadas en #813: logos de Amado y carteles de embalaje/envío. Sus SHA256 originales se guardan junto a las huellas. Los otros identificadores ya revisados siguen cubiertos por el filtro exacto.

El navegador inspecciona miniaturas con dos cargas simultáneas como máximo, después de un turno de inactividad. Si una imagen no carga, el canvas no es legible por CORS o vence el plazo de 4 segundos, se conserva. No se descargan imágenes de referencia: las huellas vienen incluidas en la página.

## Evidencia local — 25/11/2026

42 pruebas focalizadas aprobadas:
- Clic real del controlador de carrito sobre los datos generados por Regalos, precio/unidades y segundo clic.
- Formulario con contacto inválido, corrección y envío simulado; rechazo equivalente en la API.
- 35 imágenes originales revisadas visualmente: 14 carteles y 21 fotos/tapas/contratapas/material del libro. Cada una se prueba original, JPEG de 96 px/calidad 35 y JPEG de 240 px/calidad 75: 105 casos, sin falsos positivos ni carteles omitidos en esta muestra.
- Navegación completa del controlador de galería tras excluir un cartel y estado vacío cuando todas las imágenes son carteles.
- Fallos de imagen y CORS conservan la foto; máximo de dos cargas en paralelo.

Las variantes se decodificaron y recomprimieron con System.Drawing. El fixture guarda huellas, hashes de procedencia y tres muestras de píxeles para comprobar el cálculo. Los controladores de página se ejecutaron con Node VM y DOM simulado; no equivale a una medición visual en un teléfono.

## Comprobación tras desplegar

Abrir Regalos y fichas en 375 px y escritorio. Probar carrito, aviso de contacto y una ficha con copia recomprimida de un cartel conocido. Comprobar que CORS permite leer las miniaturas y que tapas e interiores permanecen visibles. El navegador local de esta sesión no inició, por lo que esa comprobación de renderizado queda pendiente. Las pruebas no crearon pedidos, cobros ni correos reales.
