# Reservas de stock

Cómo evita la web que dos personas paguen el mismo ejemplar, y qué queda fuera.

## El problema

El catálogo trae el stock de la última sincronización con Mercado Libre, que
corre una vez por día. Hasta la siguiente, la web no descontaba ni sus propias
ventas: dos compradores podían iniciar y pagar el mismo ejemplar.

## Qué hace ahora

No hay tabla nueva: se leen los pedidos que ya existen
(`functions/_shared/stock-reservations.js`).

| Situación de otro pedido | Efecto | Qué ve el segundo comprador |
| --- | --- | --- |
| Pagado por la web después de la última sincronización | Venta firme: se descuenta del stock | El libro figura agotado en el carrito (mensaje de siempre) |
| Pago pendiente (Abitab, RedPagos), hasta 72 horas | Venta firme: se descuenta | Ídem |
| Pedido abierto de otra persona, todavía sin vencer (una hora) | Reserva: frena el alta, no lo muestra agotado | "En este momento otra persona está completando la compra de «…». Si no la concreta, vuelve a estar disponible en unos minutos…" |
| Pedido cancelado, devuelto o vencido sin pago | No cuenta | Compra normal |

Dos altas en el mismo instante por el último ejemplar: el lote que inserta el
pedido termina con un candado que cuenta todo lo comprometido, incluido ese
pedido. Si supera el stock, la base deshace el lote completo y pasa una sola.

### La misma persona: se reutiliza el pedido en marcha

Quien cambia la entrega, el medio de pago o el carrito genera un pedido nuevo.
Su pedido anterior no la frena, pero sí cuenta para el stock. Si el ejemplar no
alcanza para los dos:

- **El pedido anterior no tiene nada en marcha** (sin link de pago, sin link en
  generación y sin pago pendiente): el pedido nuevo lo reemplaza. Se cancela en
  el mismo lote que crea el nuevo (evento `superseded`, con el pedido que lo
  reemplaza). Si el lote falla, no cambia nada.
- **El pedido anterior ya está generando un link, tiene uno o tiene un pago
  pendiente:** no se cancela para liberar stock. El pedido nuevo no se crea y la
  persona ve: "Ya tenés un pedido en curso por este libro. Podés seguir con ese
  pedido o intentar de nuevo en unos minutos, cuando se libere…". El pedido
  anterior sigue pagable con su mismo link, y deja de contar cuando vence (una
  hora).

La condición "sin link ni link en generación" está dentro de la misma sentencia
atómica que cancela, así que no hay un hueco entre mirar y cancelar: o se
cancela antes de que empiece el link (y el link pide 410), o el link empezó
primero y el pedido no se cancela. Si un pedido se cancela de otra forma
mientras su link se genera, el link no se guarda ni se entrega.

Un pedido cancelado no puede pedir link de pago ni confirmarse por
transferencia. Esta corrección no llama a Mercado Pago para vencer links: no
hay ninguna llamada nueva.

No se reemplaza nada cuando el stock alcanza para los dos pedidos, ni cuando el
pedido anterior ya está pagado o tiene un pago pendiente en un local de
cobranza: en esos casos el libro figura agotado, como para cualquiera.

"Misma persona" es mismo correo o mismo teléfono.

### Cuándo deja de descontarse una venta web

Cuando el catálogo se vuelve a sincronizar después del pago (con 15 minutos de
margen, porque la sincronización tarda en leer Mercado Libre). A partir de ahí
manda el stock que trae el catálogo.

## Lo que no cambia

Precios, descuentos, envío, totales y validaciones de pago. Tampoco toca
Mercado Libre: no baja stock ni pausa publicaciones.

## Límites conocidos

- **Ventas hechas en Mercado Libre.** Se siguen viendo recién en la sincronización diaria. Un libro vendido allá a la mañana sigue ofreciéndose en la web hasta la madrugada. Esto no lo resuelve este cambio.
- **Baja manual en Mercado Libre.** Tras una venta web, si nadie baja el stock en Mercado Libre antes de la sincronización siguiente, el catálogo nuevo vuelve a traer ese ejemplar y la web lo ofrece otra vez.
- **Transferencias.** El pedido reserva una hora, igual que los demás. Si la transferencia llega después, el ejemplar ya no está reservado. Extender ese plazo es una decisión comercial que no se tomó acá.
- **Pago pendiente, 72 horas.** Es el plazo elegido para no ofrecer un libro que alguien está pagando en un local de cobranza. Si el cupón vence antes, el ejemplar queda tomado de más hasta completar las 72 horas.
- **Misma persona.** Se reconoce por correo o teléfono escritos igual. Quien cambie los dos queda tratado como otra persona hasta que venza su pedido anterior.
- **Prueba de integración con Mercado Pago, aparte.** Las pruebas usan un doble de Mercado Pago. Esta corrección no depende de Mercado Pago, pero sigue pendiente una compra de prueba real del recorrido completo (pedido, link, pago).
- **Quien quiere cambiar su pedido con link vigente.** Hasta que el link venza (una hora) no puede crear otro por el último ejemplar; se le pide seguir con el que tiene.
- **Transferencia sobre un pedido reemplazado.** Si la persona transfiere por el pedido anterior, el panel lo muestra cancelado; el pago se asigna a mano al pedido nuevo.
- Si la lectura de reservas falla, el carrito valida contra el catálogo como antes y el candado del alta sigue actuando.


## Pago recibido después de cancelar

Un pago que supera todas las validaciones se registra como dinero recibido: se
limpia la marca de cancelación y se guarda el evento idempotente
`payment_after_cancellation` en el mismo lote. El aviso interno pide revisar
el stock y coordinar con el cliente antes de preparar la entrega. No se
devuelve dinero automáticamente.

Las ventas firmes se descuentan aunque conserven una marca de cancelación
residual; esto protege también datos históricos. Los pedidos cancelados sin
pago no reservan. La prueba `auditoria-reemplazo-y-pago.test.js` usa handlers
reales, todas las migraciones y SQLite: cubre el pago tardío, su aviso, los
datos históricos y la creación simultánea del enlace y del pedido nuevo.
Las dependencias externas están simuladas y la red se bloqueó en la corrida
local; sigue pendiente la compra completa en Mercado Pago de prueba.
