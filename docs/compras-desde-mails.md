# Cargar compras a proveedores desde los mails

El correo diario de reposición dice "ya pedido" y "última compra" a partir de las
compras cargadas en D1. Este circuito las carga leyendo los mails y los PDF de
los proveedores, sin tocar el repo con datos (**el repo es público**: costos,
ISBN y cantidades nunca van en claro a un archivo, un registro de Actions ni un PR).

## Cómo viaja el dato

1. Una sesión de Claude (a pedido o la tarea diaria) busca los mails con el conector de Gmail y
   descarga el adjunto (`download_gmail_attachment`).
2. `scripts/purchases/preparar.mjs` lee el PDF con `pdftotext`, lo verifica contra sus propios totales
   (unidades y monto: si no cuadra, no devuelve nada), lo valida con las reglas del Worker, lo comprime y
   lo cifra con la clave pública del Worker (`scripts/purchases/clave-publica.json`).
3. Con `--enviar` dispara la acción **Importar compras** con `gh`. El texto sellado va del archivo a GitHub
   sin pasar por la conversación (no gasta tokens).
4. La acción lo entrega al Worker con `SYNC_SECRET`. El Worker lo descifra (la clave privada vive solo en D1),
   **saltea lo ya cargado** (mismo proveedor, año y dígitos del número, aunque cambie el guion) para no pisar
   correcciones manuales, e importa lo nuevo. En los registros públicos solo se ven conteos.

## Qué buscar en Gmail

| Proveedor | Búsqueda | Cómo se lee |
| --- | --- | --- |
| Celesa | `from:administracion@celesa.com has:attachment filename:pdf newer_than:7d` (asunto "Envío de documento CF-xxxx") | `--proveedor celesa` |
| SBS | `from:admventas@sbs.com.ar subject:"Notificación de Pedido" has:attachment newer_than:7d` | `--proveedor sbs` |
| Arnoia | `from:arnoia.com subject:"Pedido enviado a Arnoia"` | a mano: armar un JSON (ver abajo) y `--json` |
| Amazon | `from:amazon (subject:Pedido OR subject:Enviado)` | a mano: título sin ISBN, `--json` |

```bash
node scripts/purchases/preparar.mjs --proveedor celesa --salida /tmp/sellado.txt --enviar factura1.pdf factura2.pdf
node scripts/purchases/preparar.mjs --json compras.json --salida /tmp/sellado.txt --enviar
```

Un PDF que no cuadra o no se reconoce corta con un error claro y no envía nada.

## Reglas que usa cada lector

- **Celesa:** factura (`BILL`), euros. El número queda con guion (`CF-10256`) como en el asunto del mail.
  El envío internacional no es una línea: va dentro del monto total (el costo por libro lo reparte).
  Notas de crédito: no soportadas todavía (corta con `celesa_tipo_no_soportado`).
- **SBS:** pedido (`PE`), pesos argentinos. Se carga como `encargo_cliente` porque los pedidos a SBS salen
  cuando un cliente compra una oferta AMADO-AR: no suman al stock propio.
- **Arnoia / Amazon:** JSON con `supplier`, `document_type`, `document_number` o `supplier_order_id`,
  `document_date`, `currency`, `items[{isbn|title, quantity, unit_price}]`. Mismas reglas de `POST /purchases/import`.

## Primera vez

`Importar compras` con `accion=clave` crea la clave del Worker y muestra la parte pública en el resumen de la
corrida. Se guarda en `scripts/purchases/clave-publica.json` (la parte pública se puede publicar).

## Qué no hace

- No carga cobertura de proveedores ("faltan cargar las de X"): eso sigue siendo `POST /purchases/coverage`.
- No decide si una compra llegó: la fecha de recepción se carga a mano en el panel de compras.
