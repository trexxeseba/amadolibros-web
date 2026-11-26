# Regalos, galerías y avisos de stock

## Resultado

- Regalos permite agregar libros disponibles al carrito. El segundo clic abre el carrito sin duplicar unidades; WhatsApp sigue disponible para consultas.
- El aviso de stock valida WhatsApp o correo con las mismas reglas en la ficha y en la API. Mantiene CAPTCHA y la comprobación de disponibilidad.
- La galería oculta carteles conocidos de miniaturas, imagen principal y zoom. Compara proporciones, huella perceptual de luminancia de 32 × 32 y colores en 4 × 4 celdas contra 14 referencias revisadas; conserva las imágenes si la carga o la lectura por CORS falla.
- Ambos clientes serializados incluyen el ayudante que esbuild introduce con `keepNames`. La validación de CI ejecuta sus pruebas también sobre el módulo empaquetado: detecta el error `__name is not defined` que el código fuente sin empaquetar no mostraba.

## Evidencia del 26/11/2026

Versión revisada de la rama: `52b0e541836331835e297f7468e3fd9ec11b54c6`.
Versión de integración usada por GitHub Actions: `8db6ff4b847cfeb204e141d4c836719ed4c81802`.

- [CI completo aprobado](https://github.com/trexxeseba/amadolibros-web/actions/runs/45835496313): 3.419 ejecuciones de pruebas, sintaxis y compilaciones con checkout apagado y encendido.
- [Despliegue y auditorías de Preview](https://github.com/trexxeseba/amadolibros-web/actions/runs/45835496050): revisión comercial, productos de muestra, datos bibliográficos y enlaces aprobados.
- [Capturas y reporte del navegador](https://github.com/trexxeseba/amadolibros-web/actions/runs/45835496050/artifacts/15125655902), artefacto `purchase-ui-pr-822`.

En Chrome automatizado, a 375 × 812 y 1440 × 900:

| Comprobación | Resultado |
| --- | --- |
| Regalos, carrito, ficha y aviso de reposición | Ancho del documento igual al viewport; sin desborde horizontal |
| Primer y segundo clic en Agregar al carrito | Una unidad; segundo clic abre el carrito |
| Contacto inválido | Error visible; ninguna solicitud enviada |
| Corrección y envío válido | Cliente llega al estado de éxito con respuesta interceptada |
| JavaScript | Sin errores de página en los recorridos |
| Imágenes de enlaces | Ninguna sin texto alternativo en la muestra |

Ficha agotada usada: `MLU1416777650` (Murdoku). El envío de aviso se interceptó en el navegador: no se registró ningún contacto y no se comprobó la entrega de un correo real ni un desafío CAPTCHA real.

Se probaron las galerías `MLU1494548512`, `MLU1447482978`, `MLU626310388`, `MLU1256360946` y `MLU1465393798`. El filtro desplegado ocultó una imagen en cada una, sin errores de JavaScript ni CORS. En la última ficha se reemplazó una miniatura solo dentro del navegador por tres variantes controladas de un cartel: JPEG 96 px/calidad 45, JPEG 240 px/calidad 85 y WebP 480 px/calidad 75. Las tres se ocultaron. No se cambió ninguna imagen del servidor.

La muestra local anterior sigue cubierta: 35 imágenes revisadas (14 carteles y 21 fotos/tapas/contratapas/material del libro), en original y dos variantes JPEG: 105 casos sin falsos positivos ni carteles omitidos dentro de esa muestra.

## Alcance y límites

El filtro no es un clasificador universal. Carteles con otras composiciones requieren nuevas referencias revisadas. Se conserva el filtro exacto existente.

La versión de prueba tiene el cobro apagado. Estos controles no son una compra completa con Mercado Pago: no crearon pedidos, cobros ni correos reales. Las capturas completas pueden mostrar imágenes aún no cargadas fuera del viewport por la carga diferida; no se contabilizan como imágenes rotas sin desplazarse hasta ellas.

El script `scripts/commerce/check-preview-purchase-ui.mjs` solo admite dominios de Preview, bloquea las escrituras de API ajenas a la validación de carrito e intercepta el aviso de stock. El workflow lo ejecuta en este PR y conserva las capturas durante 30 días.
