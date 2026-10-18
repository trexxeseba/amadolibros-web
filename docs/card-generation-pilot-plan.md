# Piloto de variantes v2 (Cloudflare Images) — plan ejecutable

Estado: **preparado, NO ejecutado.** Solo Preview. Producción: cero escrituras, cero despliegues, cero activación. Los controles descritos aquí están probados con simuladores; **no se declaran operativos** hasta que el piloto los demuestre contra R2 e Images reales.

## 0. Qué se escribe, dónde y qué no

Worker temporal `worker-sync/card-generation-preview.js` (config `card-generation-preview.wrangler.toml`), desplegado con nombre por ejecución y eliminado al terminar. Todo exige `Authorization: Bearer <token por ejecución>`; no hay ruta pública ni dominio de producción.

| Bucket | Operaciones permitidas (impuestas en código por `previewFacade` / `sourceFacade`) |
|---|---|
| `amadolibros-images-preview` | GET/HEAD/PUT **solo** de `covers/generation-ledger/v2/<AAAA-MM>/ledger.json` y `covers/variants/v2/<hash>/v2-(240\|360\|480)-q85.webp` |
| `amadolibros-images-production` | GET/HEAD **solo** de `covers/v1/objects/<hash>.<jpg\|png\|webp>` y `covers/variants/v1/<hash>/v1-<ancho>-q<q>.webp`. Sin PUT, DELETE ni LIST (la fachada ni siquiera los expone). |

Cualquier otra clave, método, bucket o binding ausente se rechaza antes de tocar R2 (probado). Wrangler no permite declarar un binding R2 de solo lectura: la garantía es el código y su prueba, y se confirma en el paso 6 con una comparación antes/después de producción (no con un registro de operaciones: el Worker no lo tiene).

Topes dentro del propio Worker (no configurables por quien llama): `maxNewAttempts ≤ 100`, plan ≤ 20 masters, `limit ≤ 40` por ejecución, techo absoluto de la cuenta 30.000.

## 1. Consumo previo del mes (paso 0, solo lectura)

El libro mayor **no acepta un número tipeado**: exige un informe de uso con `source: cloudflare-billable-usage`, período del mes en curso, `billed_transformations` entero, `observed_at` de menos de 24 h y `raw_sha256` de la captura cruda que lo respalda. El mismo informe se vuelve a exigir en cada ejecución; si el uso informado por la cuenta ya supera lo registrado, **gana el mayor** (otros usos de Images gastan el mismo cupo).

Cómo se obtiene: con el token de Cloudflare **ya configurado** en Actions (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), sin crear credenciales ni ampliar permisos:

```bash
node scripts/images/capture-images-usage.mjs artifacts/pilot/usage-raw.json
```

Hace un único GET a `api.cloudflare.com` (HTTPS, host fijo, sin redirecciones), guarda la respuesta **cruda** y su SHA-256, y no interpreta nada. La plantilla de URL (`IMAGES_USAGE_URL_TEMPLATE`) es **la parte sin verificar**: no pude contrastarla con la documentación ni con la API desde este entorno. El primer resultado debe revisarse a mano; solo entonces se escribe la conversión a informe de uso, ajustada a la forma real de la respuesta (no se adivina).

**Si todavía no está disponible** (HTTP 401/403, endpoint distinto, respuesta sin el dato): no se inicializa el libro mayor y la generación queda detenida con `usage-unavailable`/`ledger-missing`. El piloto espera. No se asume cero ni se inventa un valor. Decisión pendiente para Seba, sin implementar: permitir un piloto con un libro mayor de tope relativo mínimo (≤ 32 intentos ≈ USD 0,016) usando la cifra de "Uso facturable" leída del panel de la cuenta, registrada como captura. Solo si Seba lo aprueba por escrito.

## 2. Los diez masters (propuesta por procedimiento)

El listado de masters del plan de 2.788 es privado (solo se publicó su digest) y esta sesión no lee producción, así que **no puedo darte hashes reales todavía**. Lo que sí está cerrado es el procedimiento determinista y probado:

```bash
node scripts/images/select-pilot-masters.mjs manifest-congelado.json v1-inventory-keys.json artifacts/pilot/selection.json
```

Entradas (solo lectura): el manifest congelado (artifact `12087843537` del 17/10 o uno más reciente) y la lista de claves `covers/variants/v1/` actual (con el Worker de solo lectura `/inventory?prefix=covers/variants/v1/` de #441, o un ListObjectsV2 de lectura). Candidatos: portada posición 0, sin **ninguna** receta v1 (no genera nada reutilizable). Diez estratos, el hash menor de cada uno: jpg estándar ×2, png, webp, apaisado, muy alto, grande (≥1500 px), angosto (241–359), diminuto (≤240), y 361–479 (parte las recetas 360 y 480 sin ampliar). Un undécimo master, aparte, para el ensayo de cupo agotado. Estratos vacíos se rellenan y se **informan**; con menos de 11 candidatos, falla.

Salida: dos planes cerrados (`pilot`, 30 variantes; `exhaustion`, 1 master) con `items_sha256`. **Seba aprueba el digest** antes del paso 4: el generador exige que la aprobación sea igual al digest y rechaza cualquier plan alterado.

## 3. Despliegue del Worker temporal

Reutiliza el patrón y el script de guarda existentes sin modificarlos (el nombre debe calzar con su expresión):

```bash
export WORKER_NAME="amado-cover-fix-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
PILOT_TOKEN=$(openssl rand -hex 32); echo "::add-mask::$PILOT_TOKEN"
bash scripts/deploy-cover-preview.sh --config worker-sync/card-generation-preview.wrangler.toml --var "PILOT_BUILD_SHA:$GITHUB_SHA"
printf '%s' "$PILOT_TOKEN" | npx wrangler@3.114.17 secret put PILOT_TOKEN --config worker-sync/card-generation-preview.wrangler.toml --name "$WORKER_NAME"
# al terminar, SIEMPRE (trap): DELETE del Worker, como en card-canary-preview.yml
```

## 4. Secuencia del piloto (cada paso con su criterio de parada)

1. `GET /ready` devuelve el commit esperado.
2. `POST /init` `{maxNewAttempts: 32, usage}` → ledger de Preview con `prior_consumed` = uso real. Un segundo init debe fallar (`ledger-exists`).
3. `POST /run` con el plan `pilot` y su digest, `limit: 40`. Esperado: 30 intentos, 30 creados, `complete: true`. Parada inmediata ante cualquier `stopped` distinto de `null`.
4. **Verificación de cada objeto** (30): clave exacta `covers/variants/v2/...`, `image/webp`, metadatos (`master_sha256`, `recipe`, `sha256`, `encoder: cloudflare-images`, `width`, `height`, `source_*`), SHA-256 de los bytes = metadato, ancho = `min(ancho del master, receta)`, alto proporcional ±1, ningún ancho mayor al master.
5. **Reanudación:** repetir el mismo `/run`: 0 intentos, 0 llamadas a Images, `consumed` sin cambios. Además, repetir tras interrumpir el job a mitad (cancelar la ejecución y esperar > 120 s de arrendamiento): el `pending` se reconcilia contra R2 y el consumo no se devuelve.
6. **Cero escrituras productivas:** comparar, antes y después del piloto y con el mismo acceso de solo lectura, el ETag de `covers/v1/manifest.json`, el conteo de objetos bajo `covers/variants/v1/` y `covers/variants/v2/` en producción (este último debe seguir en 0), y que los 30 objetos v2 existan en Preview. Complementa, no sustituye, la prueba de la fachada.
7. **Cupo agotado:** `POST /run` con el plan `exhaustion` (3 recetas) con 2 intentos restantes → 2 creados y el tercero se detiene con `budget-exhausted`; después, otra ejecución: 0 intentos.
8. **Calidad frente a Sharp:** descargar cada v2 (`GET /object/<hash>/<receta>`), generar con Sharp q85 (receta v1 actual) a partir del mismo master, y comparar: dimensiones iguales, relación de bytes, PSNR/SSIM frente a un reescalado de referencia, y hojas de contacto lado a lado para **revisión visual de Seba**. No se asume equivalencia de calidad entre q85 de Sharp y de Cloudflare.
9. Entrega medida: servir un v2 con `?variant=v2-360-q85` en Preview y comprobar tipo, ETag y caché; una receta v2 ausente debe devolver 503 no-store en Preview (nunca redirigir a producción).
10. Limpieza: eliminar el Worker; el ledger y los v2 quedan en Preview como evidencia.

## 5. Costo y consumo medido

Máximo del piloto: **32 transformaciones ≈ USD 0,016** a USD 0,50 por 1.000, sin descontar la cuota incluida. Se informa el consumo real (`consumed`, `succeeded`, `failed` del libro mayor) más el uso de la cuenta antes y después. Si el uso de la cuenta aumenta más que `consumed`, se informa la diferencia (otros usos o retraso de facturación).

## 6. Criterios para continuar (los decide Seba con los resultados)

Continuar solo si: 30/30 verificados; reanudación sin gasto; cupo agotado detiene sin llamar a Images; cero escrituras fuera de la tabla; calidad visual aceptada; peso comparable o menor; sin errores pendientes. Cualquier fallo detiene el avance y se informa. Nada de esto autoriza producción: la generación en el bucket productivo, el índice mixto publicado y el modo público limitado requieren aprobaciones aparte.

## 7. Falta implementar antes de ejecutar

- Workflow `workflow_dispatch` del piloto y el verificador de los pasos 4–9 (patrón de `card-reuse-preview-check.mjs`). No se agregaron para no sumar infraestructura sin su visto bueno.
- Conversión del resultado crudo de uso a informe (depende del paso 1).
- Hojas de contacto y métricas del paso 8.
- Modo de emisión pública limitado y su reversión (punto 6 de la orden): sin empezar.
