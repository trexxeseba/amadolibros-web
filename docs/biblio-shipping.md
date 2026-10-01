# Biblio shipping — Amado Libros

Respaldo documental. El shipping se configura en BiblioDirect → Shipping Matrix
(biblio.es/app/booksellers/shipping_matrix), NO en el TXT de inventario.
Última carga verificada: 17/9/2026 (moneda de la cuenta: USD).

## Política
- Precio del libro en USD, separado del envío.
- Sin envío internacional gratis.
- Estándar internacional: Correo Uruguayo, pequeño paquete certificado (con seguimiento). No EMS.
- Rápido internacional: FedEx International Connect Plus (cuenta corporativa).
- Express: sin modificar (Biblio lo limita a nacional).
- España no tiene zona propia en Biblio: va dentro de Europe and UK.
- Libros de más de 1 kg: se pide la diferencia de envío desde la orden (Biblio lo permite).

## Matriz cargada (USD)

Estándar
| Zona | Primer libro | Adicional | Días |
|---|---|---|---|
| Domestic (Uruguay) | 9,00 | 3,00 | 5–7 |
| Europe and UK | 73,00 | 6,00 | 20–35 |
| United States and Canada | 69,00 | 14,00 | 20–35 |
| Australia and South Pacific | 77,00 | 6,00 | 20–35 |
| Rest of the World | 77,00 | 6,00 | 20–35 |

Rápido
| Zona | Primer libro | Adicional | Días |
|---|---|---|---|
| Domestic (Uruguay) | sin modificar | sin modificar | — |
| Europe and UK | 111,00 | 5,00 | 5–10 |
| United States and Canada | 109,00 | 5,00 | 5–10 |
| Australia and South Pacific | 111,00 | 5,00 | 5–10 |
| Rest of the World | 130,00 | 5,00 | 5–10 |

## Fórmula
precio_envío = (costo transportista + embalaje) / 0,785
- 0,785 = 1 − 21,5%: comisión Biblio sobre libro+envío (12% plan base + 5,5% procesamiento de pago) + 4% retiro PayPal a Uruguay (hipótesis).
- Base: libro hasta 1 kg. Adicional = salto a 1,5 kg en el mismo paquete.
- Embalaje: USD 3 por paquete + USD 1 por libro adicional (hipótesis).
- Correo Uruguayo: tarifario vigente desde nov-2025, pequeño paquete certificado 501 g–1 kg, a 40,22 UYU/USD.
- FedEx Connect Plus: tarifa plana hasta 2,5 kg (zona A 66, B y C 67, D 79) + 25% combustible supuesto, sin descuento corporativo.

## Pendiente de verificación
Al abrir la matriz antes del ftp_upload, chequear solo: importes iguales a esta tabla y días internacionales 20–35 / 5–10 (los selectores de días se habían reseteado tras un guardado fallido el 17/9).

Lo demás de tu plan queda igual: no tocar código, verificar matriz en BiblioDirect, artifact_only, revisar archivo, ftp_upload, purge_replace solo después.
