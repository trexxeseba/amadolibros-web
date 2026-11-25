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

### La misma persona: el pedido nuevo reemplaza al anterior

Quien cambia la entrega, el medio de pago o el carrito genera un pedido nuevo.
Su pedido anterior no la frena, pero sí cuenta para el stock. Si el ejemplar no
alcanza para los dos:

1. Si el pedido anterior ya tenía link de pago de Mercado Pago, primero se
   vence ese link. Si Mercado Pago no confirma que lo venció, el pedido nuevo
   no se crea y la persona ve: "Ya tenés un pago iniciado por este libro…".
2. El pedido anterior se cancela en el mismo lote que crea el nuevo (evento
   `superseded`, con el pedido que lo reemplaza). Si el lote falla, no cambia
   nada.

Un pedido cancelado no puede pedir link de pago ni confirmarse por
transferencia. Así no quedan dos pedidos abiertos de la misma persona por el
último ejemplar.

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
- **Vencimiento del link en Mercado Pago, sin probar contra la cuenta real.** Las pruebas usan un doble de Mercado Pago. Falta confirmar con una compra de prueba que Mercado Pago rechaza un pago sobre un link vencido cuando la persona ya tenía abierta la pantalla de pago. Si un pago así entrara igual, el pedido reemplazado quedaría pagado (las validaciones de pago no cambian) y habría que devolver uno de los dos.
- **Link creado en el mismo instante que el reemplazo.** Si el pedido anterior obtiene su link justo mientras se crea el nuevo, el link se vence después del alta; el resultado queda en el evento `superseded_link_expired` o `superseded_link_not_expired`.
- **Transferencia sobre un pedido reemplazado.** Si la persona transfiere por el pedido anterior, el panel lo muestra cancelado; el pago se asigna a mano al pedido nuevo.
- Si la lectura de reservas falla, el carrito valida contra el catálogo como antes y el candado del alta sigue actuando.
