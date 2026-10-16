# Checkout: antes y después (capturas locales, 390 px)

Capturas con Playwright sobre un build local (carrito de dos libros, API simulada).
Pasos hasta pagar: antes y después son los mismos 3 datos (retiro) o 6 (envío),
pero ahora se evita 1 clic (casilla de retiro) y 1 selección (departamento ya en Montevideo).

- Casilla de retiro: reemplazada por un aviso fijo; el pedido sigue enviando `pickup_ack: true`.
- Validación en línea al salir de cada campo; al enviar se muestran todos los errores juntos.
- Bloque de confianza junto al botón de pagar, con logos de Mercado Pago, Visa y Mastercard.
- Bloque de Google debajo del botón.
- No verificado localmente: el envío real de la orden (Turnstile no corre en local).
  Verificar en el preview de Cloudflare.
