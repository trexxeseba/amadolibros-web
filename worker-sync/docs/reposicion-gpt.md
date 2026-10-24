# Motor de Reposición — guía para GPT (Amado Operaciones)

Hechos por ISBN para decidir reposición: ventas reales de Mercado Libre,
compras a proveedores, stock propio y disponibilidad SBS. El backend **no**
calcula URGENTE / COMPRAR N / NO REPONER: entrega los datos y las banderas.

## 1. Lectura: `POST /operations/reposicion`

`https://amadolibros-sync.undiaes.workers.dev/operations/reposicion`

Mismo sobre firmado que `/operations/read` (header `Authorization: Amado-Signature <payload>.<firma>`,
ECDSA P-256 con la misma clave), con estos claims:

| claim | valor |
|---|---|
| `v` | `1` |
| `iss` | el mismo issuer de Amado Operaciones |
| `aud` | `"amado-reposicion-read"` |
| `seller_id` | `"440298103"` |
| `method` / `path` | `"POST"` / `"/operations/reposicion"` |
| `iat`, `exp` | segundos; `exp - iat ≤ 60` |
| `jti` | UUID nuevo en **cada** llamada (se rechaza si se repite: 409) |
| `action`, `args` | ver tabla |

| action | args | devuelve |
|---|---|---|
| `estado` | `{}` | salud de ventas ML, fecha del catálogo, cobertura de compras por proveedor, proveedores sin cobertura |
| `reposicion_hechos` | `{isbns: [1..50]}` | por ISBN: stock propio, ventas propio / encargo SBS (30/90/180/365), compras (30/90/180/365, última, en tránsito), SBS, plazo, `fuente_incompleta[]`, `revisar[]`, `estado_datos` |
| `candidatos` | `{limite: 1..50}` | lo mismo, para los ISBN con ≥2 ventas propias en 365 días y stock propio ≤1, ordenados por ventas de 90 días |
| `ventas_titulo` | `{titulo}` | ventas por título (para ventas sin ISBN) |
| `compras_titulo` | `{titulo}` | compras por título |
| `revision_identidad` | `{limite: 1..100}` | ventas y compras sin ISBN, ordenadas por unidades, para resolver a mano |
| `competencia_hoy` | `{limite: 1..100}` | novedades de competencia de la última foto diaria: perdiste/ganaste el 1.º lugar, competidor que dejó de ofrecer el libro (con "probablemente lo vendió" si subió su contador de ventas), competidor nuevo, solo en el catálogo, precio arriba/abajo |

Cada resultado de `reposicion_hechos` y `candidatos` trae además `avisos` (texto listo para mostrar; el primero suele ser
"Compraste N hace X días (PROVEEDOR)" si hubo compra en los últimos 60 días) y `competencia` (competidores en el
catálogo, precio mínimo, tu precio, precio relativo, estado del 1.º lugar y precio para ganar). La competencia sale de
la API oficial de Mercado Libre: las ventas por libro de los competidores no se conocen; "probablemente lo vendió" es
una inferencia.

### Reglas de los datos
- **Stock propio**: publicaciones propias activas en ML. La propia y la de catálogo comparten ejemplar: se toma el máximo. Las publicaciones `AMADO-AR-` (encargo SBS) no son stock.
- **Ventas propio vs encargo SBS**: las de SKU `AMADO-AR-` son señal para pasar a stock, no demanda base.
- **Canceladas** no cuentan como venta (se informan aparte). Historia de ML: 12 meses (`cobertura_desde`).
- **Plazo de entrega**: 15 días para todos los proveedores. **En tránsito estimado** = compras de los últimos 15 días.
- `estado_datos`: `FUENTE INCOMPLETA` (no decidir) → `REVISAR` (decidir con cuidado, ver motivos) → `LISTO_PARA_DECIDIR`.

| bandera | significado |
|---|---|
| `ventas_ml_desactualizadas` | el sync de órdenes no corre o falla |
| `stock_propio_desactualizado` | catalog.json tiene más de 48 h |
| `compras_no_cargadas:<proveedores>` | sin compras para el ISBN y hay proveedores obligatorios sin historia cargada |
| `compras_sin_isbn_posibles` | hay compras sin ISBN que podrían ser este libro |
| `publicaciones_con_stock_distinto` | dos publicaciones activas con cantidades distintas |
| `posible_demanda_censurada` | sin stock, vendía (≥2 en 365 días) y no vendió en 90: probablemente por quiebre |
| `encargo_sbs_supera_propio` | se vende más por encargo que de stock: evaluar pasarlo a stock |
| `posible_sobrestock` | stock + en tránsito ≥ ventas propias de 180 días |

## 2. Carga de compras (JSON v2)

Se pega en `https://www.amadolibros.com/panel/compras` (sesión del panel).
GPT **no** escribe por la ruta firmada.

```json
{"documents":[{
  "supplier": "Celesa",
  "document_type": "invoice",
  "document_number": "A57307",
  "supplier_order_id": null,
  "related_order_ids": ["C-41003791"],
  "document_date": "2025-06-10",
  "received_date": null,
  "purpose": "stock",
  "currency": "EUR",
  "total_amount": 123.45,
  "source_type": "gmail_pdf",
  "source_reference": "gmail:<messageId>#<adjunto>",
  "items": [{"isbn": "978-84-...", "title": "...", "author": "...", "publisher": "...",
             "quantity": 2, "quantity_ordered": 3, "unit_price": 10.5, "discount_pct": 30, "line_total": 14.7}]
}],
"coverage": [{"supplier": "Celesa", "covered_from": "2025-10-01", "covered_to": "2026-10-20", "note": "facturas completas"}]}
```

1. **Un documento por documento físico.** Mail de confirmación de pedido = `order`; factura = `invoice`; remito/albarán/aviso de entrega = `receipt`; abono = `credit_note`. No fusionar ni elegir: el servidor deduplica (la factura reemplaza al pedido que comparte número de pedido).
2. `document_type` obligatorio. `invoice`/`receipt`/`credit_note` → `document_number` tal cual impreso. `order` → `supplier_order_id`. Sin número, no se envía.
3. `related_order_ids`: todos los números de pedido que menciona el documento. Es lo que evita contar pedido + factura dos veces. No inventar.
4. **No enviar `purchase_id`** ni usar nombres de archivo como identificador (van en `source_reference`).
5. `supplier`: el nombre como aparece (el servidor normaliza: Casassa y Lorenzo, Celesa, Arnoia, Amazon.com, Amazon.es).
6. `document_date`: fecha impresa, `YYYY-MM-DD`.
7. Números como números JSON con punto decimal. `currency` (ISO-4217) obligatoria si hay precios.
8. `quantity`: en factura/remito, la servida; en pedido, la pedida; en nota de crédito, **positiva** (el servidor resta).
9. `isbn`: tal como está impreso (13 o 10 dígitos) o `null`. Siempre `title`; `author`/`publisher` si figuran.
10. `purpose`: `"stock"` (por defecto) o `"encargo_cliente"` (no cuenta para reposición).
11. `coverage`: declarar el período de cada proveedor que quedó cargado **completo**. Sin cobertura, "cero compras" se marca FUENTE INCOMPLETA.
12. Re-importar el mismo documento (tipo + número + año) lo actualiza.

Proveedores obligatorios para afirmar "no compramos": **Celesa, Arnoia, Casassa y Lorenzo, Amazon.com** (12 meses hacia atrás).
SBS entra por su feed de stock. Amazon.es queda fuera hasta identificarlo.

## 3. Rutina semanal (lunes)
1. Seba: subir el Excel fresco de SBS.
2. Claude/GPT: extraer compras nuevas de Gmail → JSON v2; Seba lo pega en `/panel/compras` y actualiza `coverage`.
3. GPT: `estado`. Si hay advertencias globales, parar y avisar qué falta.
4. GPT: `candidatos` → tabla por ISBN con estado y motivos.
5. GPT: `revision_identidad` (top 10) para que Seba resuelva.
6. Seba aprueba y hace los pedidos.

Indicadores: quiebres en el top 50 de ventas propias · proveedores con cobertura al día · % de ventas con ISBN (meta ≥95%) · edad del feed SBS (meta ≤7 días) · compras aprobadas vs ejecutadas.
