# Precio competitivo en Mercado Libre (fichas de Catálogo)

Estado del proyecto al 25/10/2026. Este archivo es el punto de entrada: cualquier
sesión que retome el tema arranca leyendo esto.

## El problema

Amado Libros volvió a traer libros a demanda (stock 1, 21 días, envío gratis). De
unas 12.500 publicaciones activas, **9.784 pierden la ficha de Catálogo**. La
subida desde SBS publicaba todo al precio de margen completo, que en una ficha
compartida pierde contra quien ya está más abajo. El libro entra, no gana la
ficha y ocupa lugar sin vender.

## Las reglas que decidió Seba

1. **Piso de margen 15%** sobre el costo real (libro, flete por peso, mano de
   obra, envío gratis), ya descontada la comisión del 15% de ML.
2. **Mínimo $400 libres por venta.** Actúa junto con el piso de margen: manda el
   que dé el piso más alto. Sin esto, el piso por porcentaje deja monedas en los
   libros baratos (unos $120 en un libro de $1.600).
3. **Precio = precio del ganador menos 1%**, redondeado hacia abajo. Nunca por
   encima del precio de margen completo.
4. **Si ganador −1% queda bajo el piso, no se publica** (`skipped_not_competitive`)
   ni se baja un precio ya publicado (`below_floor`).
5. **No bajar contra un ganador que entrega antes que nosotros.** Ahí ML marca
   perdiendo por stock, no por precio: bajar regala margen sin ganar la ficha.
   Nuestro plazo es 21 días; si el ganador tarda 21 o más, el precio decide.
6. **Si no se puede leer el plazo del ganador, no se baja.** Ante la duda, se
   conserva el margen.

Sin competencia en la ficha, el precio es el de margen completo, como antes.

## Por qué 15% + $400, medido

Sobre una muestra de 459 fichas relevadas (las que pierden por precio contra un
ganador que también vende a demanda):

| Piso | Fichas ganables | Baja media | Libre medio |
|---|---|---|---|
| 12% + $100 | 265 de 459 (58%) | $221 | $372 |
| 12% + $300 | 177 (39%) | $216 | $440 |
| **15% + $400** | **75 (16%)** | **$207** | **$557** |
| 18% + $500 | 37 (8%) | $270 | $679 |
| 20% + $600 | 17 (4%) | $337 | $832 |

De 15% para arriba se vacía rápido. Los $557 libres promedio quedan por encima de
los $500 que Seba usa como regla para libros por encargo.

Esos números son estimaciones: el costo de cada libro salió de dar marcha atrás a
la fórmula de precio asumiendo margen objetivo 30% y envío $250.

## Qué está desplegado

| PR | Qué hizo |
|---|---|
| #509 | Precio competitivo en la cola de publicación: lee el ganador una vez por libro, lo guarda en el renglón del feed, aplica las 6 reglas. Apagado por defecto. |
| #510 | Regla de CLAUDE.md: Claude mergea sin pedir permiso con los checks en verde. |
| #511 | `competitive`, `competitive_floor_margin` y `minimum_contribution_uyu` como argumentos del lote clonado y como inputs del workflow, para no tener que editar el secret `PUBLISHER_POLICY_JSON`. |

Código: `worker-sync/publication-policy.js` (fórmula, piso, decisión),
`publication-meli.js` (lectura del ganador por API), `publication-engine.js`
(cola y acción de sólo lectura), `scripts/mercadolibre/publisher-control.mjs`
(CLI del workflow).

Los valores de la política viven en el secret `PUBLISHER_POLICY_JSON` y en el
lote guardado en D1. Activar el precio competitivo **cambia el `policy_hash`**, así
que exige un lote nuevo y una aprobación nueva: no se enciende solo.

## Cómo correrlo

Todo pasa por el workflow `Mercado Libre publication queue`, que habla con el
Worker `amadolibros-sync` usando `SYNC_SECRET`. La API de Mercado Libre sólo se
puede llamar desde el Worker: el contenedor de las sesiones de Claude la tiene
bloqueada por proxy (403 incluso en endpoints públicos).

**Ver qué haría sobre publicaciones ya activas (sólo lectura, no escribe nada):**

    action: preview_competitor
    item_ids: MLU1521238542,MLU1522928734,...   (hasta 25)
    run_id: <lote cuya política se toma como base>
    competitive: true
    competitive_floor_margin: 0.15
    minimum_contribution_uyu: 400
    availability_days: 21

Devuelve, por publicación: precio actual, precio y plazo del ganador, costo
estimado, piso, precio nuevo, baja en pesos y en %, y la decisión (`lower`,
`below_floor`, `rival_faster_delivery`, `rival_delivery_unknown`,
`already_cheaper`, `no_competitor`, `cost_unknown`).

**Preflight de un lote nuevo (valida contra ML, no publica):**

    action: clone_preflight_catalog
    run_id: <lote de origen>
    preflight_limit: 10
    availability_days: 21
    competitive: true
    competitive_floor_margin: 0.15
    minimum_contribution_uyu: 400

## Pendiente

1. Correr `preview_competitor` sobre una tanda de fichas reales y confirmar que
   la API devuelve el precio y el plazo del ganador como espera el código. Si la
   forma difiere, el libro queda al precio de margen completo (falla segura).
2. Activar la política en un lote nuevo de SBS y medir a los 7 días cuántas
   fichas pasaron a ganando.
3. Bajar las publicaciones ya activas con las mismas reglas. **Seba ve la lista
   antes de aplicar** (regla de CLAUDE.md). El motor ya existe:
   `competitiveDecision` más `preview_competitor`.
4. Las 9.784 fichas perdidas están relevadas sólo en parte (1.191 de 9.769
   leídas; Mercado Libre cortó el resto por volumen de pedidos). Falta completar
   el relevamiento para dimensionar el total.

## Bloqueos conocidos

- **`clone_preflight_catalog` sobre el lote `75f0d434` da `invalid_run_or_stale_feed`:**
  la cola exige un feed de SBS de menos de 24 horas y el de ese lote está vencido.
- **`SUPPLIER_FEED_URL` y `PUBLISHER_POLICY_JSON` están vacíos** en el entorno
  `production` de este repo, así que el workflow no puede bajar un feed nuevo ni
  crear un lote desde cero. La ingesta diaria de SBS no corre por acá.
- **El deploy del Worker falla en el paso "Sync Resend secret to Worker"** con
  "the latest version of your Worker isn't currently deployed" (Cloudflare). El
  paso anterior, el que publica el código, sí queda en success: el código llega a
  producción y los pasos siguientes quedan saltados. Verificado el 25/10/2026
  mandando un valor inválido y recibiendo `invalid_competitive` del Worker.
- **El costo de una publicación activa es estimado**, no leído: sale de invertir
  la fórmula de precio. El error va siempre para el lado conservador (estima de
  más, sube el piso), salvo que el margen asumido no sea el que se usó al
  publicar. El margen asumido viaja en la respuesta de `preview_competitor`.
