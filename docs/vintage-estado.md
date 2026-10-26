# Campaña Amado Vintage: estado y traspaso

Documento para retomar la campaña desde cualquier sesión de Claude (en la nube o
en la PC del dueño). El detalle técnico de cómo funciona está en
`docs/vintage-local.md`; acá va el estado y lo que no está escrito en el código.

## Qué es

Publica libros del proveedor SBS (Argentina) en Mercado Libre Uruguay, **sólo en
Amado Vintage (seller 2341378249)**. Nunca en Amado Libros (440298103): en octubre
de 2026 un lote anterior subió ~1.000 publicaciones no deseadas ahí.

## Dónde corre

En la PC Windows del dueño, encendida todo el día, como tarea programada
`AmadoVintagePublisher` (sin elevación):

`%LOCALAPPDATA%\Amado\VintagePublisher\run.cmd` → `scripts\vintage-local\launch.cmd`
→ `scripts\vintage_autorun.py`, con el repo en
`C:\Users\cgnso\OneDrive\Documentos\amadolibros-web` sobre la rama `main`.

Cada ciclo:
1. `git pull --ff-only` de `main` (los arreglos llegan solos; si cambió el código,
   el supervisor se reinicia).
2. `renew.mjs`: inicia sesión en `ag.sbs.com.ar` con `private\sbs.json`, baja
   "Lista completa de disponibles" (`/Home/AllPriceList`), la carga al sitio y
   pide una conexión nueva a `POST /operations/vintage-renew` con
   `private\renew-secret.txt` (= `VINTAGE_RENEW_SECRET` en Cloudflare Pages).
3. `stock-sync.mjs`: pausa lo que ya no viene en la lista, reactiva lo que vuelve
   (sólo pausas propias o por agotamiento) y ajusta precios a la lista del día
   (nunca bajo UYU 1.600, ignora saltos de más del doble, no hace nada si a la
   lista le falta más del 30 %).
4. `engine.mjs`: publica de a un libro, con reserva por ISBN en el servidor.

Parar: `%LOCALAPPDATA%\Amado\VintagePublisher\stop.cmd`. Seguir: `start.cmd`.
Registros: `%LOCALAPPDATA%\Amado\VintagePublisher\logs\` (`autorun-*.log`,
`engine-*.log`, `task.log`) y `status.json`.

Reinstalar (PowerShell **como administrador**, no pide nada si ya están los secretos):

```powershell
cd "C:\Users\cgnso\OneDrive\Documentos\amadolibros-web"
git fetch origin; git checkout -f -B main origin/main
powershell -ExecutionPolicy Bypass -File scripts\vintage-local\install-autorun.ps1 -NotifyUrl https://ntfy.sh/amado-vintage
```

`-Target N` fija la meta total de publicaciones (por defecto 10.000); al
alcanzarla el motor deja de publicar y sólo sincroniza stock y precios.

## Cómo ver el estado sin la PC

Workflow de GitHub **Vintage status (read-only)** (`.github/workflows/vintage-status.yml`),
manual desde la pestaña Actions: lee la base de producción y muestra publicados
por estado, altas por día, política de precio, conexión de la PC y lista de SBS.

## Estado al 25/10/2026, 21:59 (Uruguay)

- Publicados: **11.331** (meta de 10.000 superada). Última alta: 25/10 20:19.
- Altas por día: 21/10 1.211 · 22/10 1.978 · 23/10 2.075 · 24/10 2.160 · 25/10 1.764.
- Sin confirmar: 129 `uncertain` y 6 `creating` (se reconcilian por SKU, nunca
  con un alta nueva).
- Política: margen 35 %, mínimo UYU 1.600, descuento SBS 25 %, 40 ARS por UYU,
  18 días de disponibilidad. Sin tope diario (`VINTAGE_DAILY_CAP` = 10.000).
- Lista de SBS: se cargó todos los días (la del 25/10 tiene 81.330 filas).

## Decisiones del dueño

- Lo más funcional, simple y rápido; la seguridad la maneja él.
- Sin pasos humanos diarios: la renovación es automática.
- Sin tope diario.
- Precios siguen a SBS, subiendo y bajando.
- Libro agotado en SBS → pausado en Mercado Libre; vuelve → reactivado.
- Cada arreglo con test que falle antes y pase después (TDD), en rama + PR.
- Lo que pasa en la PC lo verifica una sesión de Claude Code **en la PC**; la
  sesión en la nube no ve la PC y sólo informa lo que muestra la base del sitio.

## Problemas ya resueltos (no repetir)

- Tarea programada con `python` por nombre o elevada → `0x80070002`. Ahora usa la
  ruta real y corre sin elevación.
- `sbs.json` escrito con BOM por PowerShell 5.1 → `renew.mjs` lo tolera.
- El Excel público de SBS dejó de actualizarse en agosto de 2026 → se baja del
  portal con usuario.
- Un libro con fotos pendientes tumbaba cada corrida → se difiere con espera.
- Un `git pull` sin rama intentó un merge y pidió identidad → `--ff-only` de la
  rama remota del mismo nombre.
- `run.cmd` viejo lanzado como administrador → "Acceso denegado" al reinstalar
  desde una consola común: reinstalar como administrador.
