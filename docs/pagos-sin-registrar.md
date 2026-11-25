# Pagos sin registrar

Qué pasa cuando Mercado Pago cobra y la web no lo puede asignar a un pedido, y
cómo se recupera un pago cuyo aviso no llegó.

## La regla que no cambia

Un pedido queda pagado sólo si el pago pasa **todas** estas validaciones: es de
nuestra cuenta de Mercado Pago, está en pesos uruguayos, su referencia es el
código de un pedido que existe, el importe es **exactamente** el total del
pedido y, si Mercado Pago informa una orden, corresponde a la orden de pago que
generó ese pedido. Nada de lo que agrega este documento marca pagado un pedido
que no las pase.

El código que valida y aplica es uno solo (`createPaymentProcessor` en
`functions/api/_mp_webhook_handler.js`) y lo usan los dos caminos de entrada.

## Dos caminos de entrada

| Camino | Cuándo | Qué hace |
| --- | --- | --- |
| Aviso firmado de Mercado Pago (`/api/webhooks/mercadopago`) | En el momento del pago | Verifica la firma, pide el pago a Mercado Pago y lo procesa. |
| Conciliación (`/api/payments/reconcile`) | Cada 5 minutos, disparada por el Worker | Busca los pagos de las últimas 48 horas, se queda con los de la web que no cierran con la base, y procesa cada uno igual que el aviso. |

La conciliación usa la búsqueda sólo para descubrir qué pagos mirar. Cada pago
se vuelve a pedir a Mercado Pago por su id antes de decidir nada.

Cuando la conciliación aplica un pago que el aviso no había registrado, el
pedido queda pagado, salen los correos de siempre y en el historial del pedido
queda el evento `payment_reconciled`. Ese evento es la señal de que el aviso
original falló.

## Incidentes

Un cobro que no se puede aplicar no se pierde: se anota en la tabla
`payment_incidents` (una fila por pago y motivo) y sale un correo a las casillas
de avisos de venta. Si el correo falla, la conciliación lo reintenta.

| Motivo | Qué significa | Qué hacer |
| --- | --- | --- |
| `importe_distinto` | Se cobró un importe que no es el total del pedido. | Ver el pago en Mercado Pago. Completar la diferencia con el cliente o devolver. |
| `pedido_inexistente` | El cobro trae un código de pedido que no está en la base. | Ver el pago en Mercado Pago y ubicar al comprador. |
| `preferencia_distinta`, `referencia_distinta`, `pago_fuera_de_la_orden` | El cobro corresponde a otra orden de pago. | Revisar en Mercado Pago a qué orden pertenece. |
| `moneda_distinta` | Cobro en una moneda que no es pesos. | Revisar el pago. |
| `pago_duplicado` | Entró un cobro aprobado para un pedido que ya estaba pagado (por Mercado Pago o por transferencia). | Devolver el pago de más. |
| `pago_devuelto` | Devolución o contracargo. | Frenar la entrega si todavía no salió. |

La tabla guarda el id del pago, el código del pedido y los importes. No guarda
datos del comprador.

Sólo generan incidente los cobros con referencia de la web (códigos `AL-…`). La
misma cuenta de Mercado Pago cobra las ventas de Mercado Libre: esas se ignoran.

## Cómo ver el estado de la conciliación

La última corrida queda en la base de pedidos, tabla `payment_reconcile_runs`
(una fila por entorno y cuenta), con la hora, el resultado y las cantidades
(revisados, de la web, candidatos, aplicados, sin asignar). El endpoint
responde lo mismo a quien lo llama.

```sql
SELECT scope, started_at, finished_at, status, summary_json FROM payment_reconcile_runs;
```

### Freno de frecuencia y llamados simultáneos

El turno de cada corrida se toma en esa misma tabla con una sentencia
condicional: corre como mucho una vez cada 4 minutos y, de varios llamados
simultáneos, pasa uno solo. No depende de KV. Si la base no confirma el turno,
la corrida no consulta a Mercado Pago y responde 503. Una corrida que quedó
colgada libera el turno sola al pasar los 4 minutos. Una vista previa tiene su
propio turno y no frena a producción.

Consulta de incidentes abiertos:

```sql
SELECT created_at, reason, public_code, payment_id, mp_amount_uyu, order_amount_uyu, source, notified_at
FROM payment_incidents WHERE resolved_at IS NULL ORDER BY created_at DESC;
```

## Límites conocidos

- La ventana es de 48 horas. Un aviso perdido que nadie mire en dos días queda fuera de la conciliación.
- Mira hasta 300 pagos por corrida (incluye las ventas de Mercado Libre de la cuenta) y procesa hasta 20 candidatos.
- No hay todavía una pantalla en el panel para los incidentes: llegan por correo y se consultan en la base.
- `resolved_at` existe para cerrar un incidente a mano; nada lo completa solo.
- Si la búsqueda de Mercado Pago falla, la corrida responde 502 y queda anotado; no hay aún una alarma sobre "la conciliación dejó de correr".
