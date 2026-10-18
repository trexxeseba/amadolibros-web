# Piloto de variantes v2 (Cloudflare Images) — plan ejecutable

Estado: **preparado, NO ejecutado.** Solo Preview. Tope del piloto: **32 intentos nuevos** (30 del piloto + 2 para el ensayo de cupo agotado, ≈ USD 0,016). Producción: cero escrituras, cero despliegues, cero activación. Los controles de presupuesto están probados con simuladores y **no se declaran operativos** hasta que este piloto los demuestre contra R2 e Images reales.

## 1. Qué se escribe, dónde y qué no

Worker temporal `worker-sync/card-generation-preview.js` (config `card-generation-preview.wrangler.toml`), desplegado con nombre por ejecución y eliminado al terminar. Todo exige `Authorization: Bearer <token por ejecución>`; sin rutas ni dominios de producción.

| Bucket | Operaciones permitidas (impuestas en código por `previewFacade` / `sourceFacade`) |
|---|---|
| `amadolibros-images-preview` | GET/HEAD/PUT **solo** de `covers/generation-ledger/v2/<AAAA-MM>/ledger.json` y `covers/variants/v2/<hash>/v2-(240\|360\|480)-q85.webp` |
| `amadolibros-images-production` | GET/HEAD de `covers/v1/objects/<hash>.<jpg\|png\|webp>` y `covers/variants/v1/<hash>/v1-<ancho>-q<q>.webp`; **solo HEAD** de `covers/v1/manifest.json` (ETag antes/después). Sin PUT, DELETE ni LIST: la fachada ni siquiera los expone. |

Topes dentro del Worker (no configurables por quien llama): `maxNewAttempts ≤ 32`, plan ≤ 10 masters, `limit ≤ 32`, techo absoluto de la cuenta 30.000. Rutas: `/ready`, `/status`, `/init`, `/run`, `/object/<hash>/<receta v2>`, `/probe-v1/<hash>` (HEAD de 3 claves v1), `/master/<hash>.<ext>` (GET), `/production-etag` (HEAD del manifest). Cualquier otra clave, método, bucket o binding ausente se rechaza antes de tocar R2.

## 2. Consumo previo de la cuenta (fase `usage-check`)

El libro mayor no acepta un número tipeado: exige un informe `source: cloudflare-billable-usage` del mes en curso, entero, de menos de 24 h, con el `raw_sha256` de la captura que lo respalda. Se vuelve a exigir en cada ejecución.

- **Piso persistente:** el libro mayor conserva el consumo más alto observado (`usage_floor`) más lo gastado desde entonces. Un informe posterior **menor** (retraso, datos parciales) nunca libera cupo (probado, incluido un 9 seguido de 3, 0 y 8).
- **Otros usos de Images** gastan el mismo cupo: lo que informa la cuenta cuenta contra el tope.
- **Endpoint:** `GET /accounts/{account_id}/billable-usage` — "Get Account Billable Usage (Version 1, Alpha)", con el token ya configurado en Actions (permiso Billing Read). Verificado contra la documentación oficial *por resultados de búsqueda* (developers.cloudflare.com no es accesible desde el entorno de desarrollo), **no contra la API en vivo**. Corrige un supuesto anterior mío (`/billing/usage/paygo`, que la documentación describe como beta restringida a cuentas seleccionadas).
- **Lo que la documentación NO confirma:** cómo aparecen las transformaciones de Images en esa respuesta, ni que exista `ConsumedQuantity` (solo aparece en fuentes secundarias; la oficial documenta `PricingQuantity`, que podría excluir la cuota incluida). Tampoco coincide el ciclo de facturación con el mes calendario del cupo de Images.
- **Por eso el conversor falla cerrado** ante cualquier forma que no reconozca: respuesta que no sea `{success:true, result:[…]}`, ninguna fila de Images/transformaciones (cero filas ≠ cero uso), cantidad cruda ausente o inválida, o filas fuera del mes UTC en curso. **No hay excepción ni cero por omisión.** Si la consulta falla, la fase `pilot` termina antes de desplegar o generar nada, y el libro mayor no se inicializa.
- La captura cruda se guarda siempre como artifact para revisión. La primera ejecución real es la verificación del endpoint; si no calza, se ajusta el conversor con Seba, sin relajar el cierre.
- Nota de costo: Cloudflare factura por transformación **única** (origen + parámetros) por mes calendario, y la cuota gratuita de 5.000 está documentada para el plan gratuito; el conteo del libro mayor (todos los intentos, sin descontar nada) es deliberadamente conservador.

## 3. Los diez masters

Esta sesión **no puede leer los artifacts ni producción** (el proxy bloquea el host de almacenamiento de Actions, y no se intentó evitarlo), así que **los diez hashes y su digest no pueden entregarse desde aquí**. Los produce la fase `propose` del workflow, sin repetir el inventario general:

1. Descarga el **manifest ya existente** del artifact del 17/10 (run `38997881346`, artifact `cover-index-38997881346`; la ruta del archivo dentro del artifact es un supuesto, y si no existe el job falla listando el contenido).
2. Elige por estratos (jpg estándar ×2, png, webp, apaisado, muy alto, ≥1500 px, 241–359, ≤240, 361–479) el hash menor de cada uno, más un undécimo para el cupo agotado.
3. Sondea solo a los elegidos (`/probe-v1/<hash>`, HEAD de 3 claves cada uno, ≤ 66 sondeos en total, cada hash una sola vez) y reemplaza a los que ya tengan alguna receta v1.
4. Publica el listado y el digest en el resumen del job y como artifact (`pilot-selection-<run>`). **No genera nada.**

Seba aprueba el `pilot_digest`; la fase `pilot` exige ese digest y lo vuelve a calcular sobre la selección descargada.

## 4. Workflow `.github/workflows/card-generation-pilot-preview.yml`

Solo `workflow_dispatch`; cada fase exige escribir `PREVIEW-ONLY-32-ATTEMPTS`; entradas siempre vía `env` (nunca interpoladas en scripts); permisos `contents: read`, `actions: read`; secretos ya existentes (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), sin crear credenciales; Worker temporal `amado-cover-fix-<run>-<intento>` (calza con la guarda de `deploy-cover-preview.sh`, que no se modificó) con limpieza siempre. Una prueba fija estas garantías.

| Fase | Qué hace |
|---|---|
| `usage-check` | Captura de solo lectura y conversión estricta. Artifact con la captura cruda y el informe. |
| `propose` | Pasos 1–4 de la sección 3. |
| `pilot` | (a) valida digest y selección; (b) **establece el consumo previo — si falla, termina sin desplegar ni generar**; (c) despliega el Worker; (d) `card-generation-pilot-check.mjs`; (e) `compare-sharp-pilot.mjs`; (f) elimina el Worker. |

**Cómo se lanza:** `workflow_dispatch` normalmente solo está disponible cuando el archivo existe en la rama por defecto, y fusionar no está autorizado. Si no se puede despachar desde esta rama, la decisión de cómo ejecutarlo (incluida una variante `pull_request` acotada al PR #441, como `card-canary-preview.yml`) es de Seba. No se probó el despacho real.

## 5. Verificador (`card-generation-pilot-check.mjs`)

Se detiene en el primer paso fallido y nunca continúa sobre un resultado dudoso:
`ready` (commit esperado) → ETag del manifest de producción → `init` con `maxNewAttempts: 32` → segundo `init` rechazado → ejecución del piloto (30 intentos, 30 creados, sin fallos ni conflictos, `complete`) → **cada objeto releído** (200, `image/webp`, clave exacta, metadatos `encoder`/`recipe`/`master_sha256`/`width`/`height`/`source_*`/`bytes`, SHA-256 de los bytes = metadato, ancho = `min(master, receta)`, alto proporcional ±1, nunca mayor al master) → libro mayor (`consumed` = intentos, sin arrendamiento) → **reanudación sin gasto** → ensayo de **cupo agotado** (2 intentos y `budget-exhausted`) y reejecución sin gasto → ETag del manifest sin cambios → `consumed ≤ 32`.

## 6. Comparación con Sharp (`compare-sharp-pilot.mjs`)

Con los **mismos bytes del master**: Sharp v1 (la receta actual, q85, esfuerzo 4) frente al v2 de Cloudflare, para cada master y receta. Calcula bytes y relación, PSNR y SSIM (por bloques 8×8, sobre luminancia) frente a un reescalado Lanczos de referencia, y genera una hoja de contacto referencia | Sharp | Cloudflare. Marca para revisión (sin bloquear): PSNR de Cloudflare más de 1,5 dB por debajo, SSIM más de 0,03 por debajo, más de 1,5× el peso, dimensiones distintas. Son métricas de apoyo: **la calidad visual la aprueba Seba sobre las hojas**; no se asume equivalencia de q85 entre codificadores.

## 7. Lo validado y lo no validado

Validado localmente (2.175 pruebas aprobadas, 0 falladas):
- `wrangler 3.114.17 deploy --dry-run` compila el Worker con sus dependencias reales (bundle de ≈2,0 MiB / 130 KiB gzip), **sin** `nodejs_compat`. La primera compilación reveló un `import 'node:crypto'` que sí lo habría requerido; se reemplazó por Web Crypto y una prueba lo impide.
- El bundle ya empaquetado responde (403 sin token, `/ready` con token).
- API de Images según la documentación oficial (por búsqueda): `input() → transform() → output() → response()`, `output` obligatorio, `quality` fija o perceptual, `anim:false`, entrada ≤ 20 MB; el generador usa `anim:false`.

**No validado:** ejecución en `workerd` real; R2 real (concurrencia de `etagMatches`, ETag de HEAD); comportamiento real de Images (orientación EXIF, calidad); el endpoint de uso en vivo; límites de subrequests por invocación (≤ 100 ítems × 3 recetas × 2 HEAD por ejecución; sin medir); el despacho real del workflow; la ruta del manifest dentro del artifact.

## 8. Recuperación

El libro mayor de un mes no se puede reiniciar (por diseño: un reinicio rompería la garantía de gasto). Un piloto fallido a mitad se reintenta en la misma ejecución solo reanudando; si el verificador falla en `init` porque el libro mayor ya existe, la decisión (por ejemplo, otro mes o borrar manualmente el libro mayor de **Preview**) es de Seba. Un intento interrumpido se reconcilia contra R2 y nunca se devuelve.

## 9. Criterios para continuar (los decide Seba con los resultados)

30/30 verificados; reanudación sin gasto; cupo agotado detiene sin llamar a Images; manifest de producción sin cambios; consumo ≤ 32 y reportado junto al uso de la cuenta antes y después; calidad visual aceptada; peso comparable o menor; sin errores pendientes. Nada de esto autoriza producción: generación en el bucket productivo, índice mixto publicado y modo público limitado requieren aprobaciones aparte.

## 10. Falta

Modo de emisión pública limitado y su reversión (punto 6 de la orden): sin empezar. Ajuste del conversor de uso tras la primera captura real. Ejecución de las tres fases con aprobación de Seba.
