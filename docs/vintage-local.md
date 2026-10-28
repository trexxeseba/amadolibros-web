# Publicador local de Vintage

`scripts/vintage_local.py` runs on the owner's PC without a browser or queue.
Python owns the OS process lock and supervises the existing Node publication
engine, rather than duplicating its validated metadata, shipping and pricing code.
Node 22.13+ (or Node 24) and Python 3 are required; no new packages are needed.

The destination is fixed to seller 2341378249 and app 4741021817925208. Prices
retain the approved policy, a UYU 1,600 floor and 18-day availability. The target
defaults to 1,000 total campaign publications, including the five pilot items.
The seller's existing receipts enforce the server-side daily cap, defined once as
`VINTAGE_DAILY_CAP` in `functions/_shared/meli-vintage-bulk.js` and reported to the
engine through the `status` action. The owner raised it to 10,000 (the campaign target),
so there is no practical daily limit; a Mercado Libre listing-quota refusal still stops
the run with `stopped_listing_quota` and a notification.

## Authorization and handoff

Open `/panel/meli-vintage-local` in the authenticated production owner panel.
Its explicit download action pauses the browser campaign, waits for any in-flight
lease, and issues a random, revocable connection expiring with the supplier stock.
Save that private connection outside the repository and cloud-synced folders.
It is not a public manifest and must never be committed, logged or shared.

The PC receives temporary access tokens from `/operations/vintage-local`;
Cloudflare retains the app secret, rotating refresh token and refresh lock.
No Books authorization or fallback is used. To prevent cross-executor duplicates,
each create is reserved in Vintage's existing seller/ISBN receipt table, and its
verified result is recorded there. Product preparation, inventory scans and ML
creation requests run locally. Local SQLite stores inventory, jobs and recovery
state. Cloudflare remains necessary for authorization and receipt bookkeeping.

Only the owner can issue a connection. The bearer route accepts fixed actions,
not arbitrary URLs, sellers, policies or run IDs. The bulk panel cannot tick or
resume while a local connection is active. Its Pause button revokes that access;
an already in-flight creation may still complete and must be reconciled by SKU.

## Run

```powershell
python scripts/vintage_local.py --excel 'C:/AMADO DESCARGAS/Listado completo de libros (5).xlsx' --inspect
python scripts/vintage_local.py --excel 'C:/AMADO DESCARGAS/Listado completo de libros (5).xlsx' --connection 'C:/private/vintage-local-connection.json' --validate-only 3
python scripts/vintage_local.py --excel 'C:/AMADO DESCARGAS/Listado completo de libros (5).xlsx' --connection 'C:/private/vintage-local-connection.json' --limit-new 3
python scripts/vintage_local.py --excel 'C:/AMADO DESCARGAS/Listado completo de libros (5).xlsx' --connection 'C:/private/vintage-local-connection.json' --target 1000
```

Default state folder: `%LOCALAPPDATA%/Amado/VintagePublisher`, outside OneDrive.
`validation.sqlite` is separate from `publisher.sqlite`; validation never sends
`POST /items`. The validated sample is saved in `items.preview.json`.
`status.json` and redirected console output contain counts and bounded error codes,
never credentials. Every real Mercado Libre 429 is appended to `rate-limit-events.jsonl`
(time, method, endpoint with ids replaced by `#`, Retry-After; no query text or tokens), to
learn which call causes it. A creation refused for the listing quota (`item.max_limit_publish`
or `user.quota_exceeded`) stops the process with state `stopped_listing_quota` instead of
trying every remaining ISBN. The read-back after a create waits up to six 10-second checks while
Mercado Libre reports the item as `paused` with `picture_download_pending` (it downloads the pictures
after the create); any other mismatch, or still paused after that wait, stops the process with
`stopped_item_readback_failed`. Under the supervisor (`vintage_autorun.py`) neither state writes STOP: the quota waits until the next day and a failed readback retries after 30 minutes. Restart with the same directory to preserve progress. A hard
process termination can leave a five-minute lease, which is allowed to expire.

The engine scans all listing statuses, canonicalizes ISBNs, checks both SKU query
forms and reserves an ISBN before sending. The SKU itself is not a uniqueness
constraint. An uncertain create is reconciled and never sent a second POST.
After creation/reconciliation it reads back seller, ISBN, exact price, quantity,
active state and 18-day availability before confirming the receipt.

Requests have a persistent two-second clock, cached static metadata and 429
cooldowns. The first version sends one creation at a time; it does not assume
four or five simultaneous requests are safe. There is a 20-second pause after 25
creations (it was 60 seconds; the pause was self-imposed, not a Mercado Libre limit). The PC must remain on and awake. Stale stock, an expired/revoked
connection or an identity mismatch stops publishing. A fresh approved stock
connection can replace an expired snapshot while retaining local receipts.

## Modo desatendido (PC encendida todo el día)

`scripts/vintage_autorun.py` mantiene la campaña corriendo sola. Renueva la
conexión cuando faltan menos de 30 minutos para que venza, ejecuta el motor,
espera al día siguiente de Montevideo cuando se alcanza el tope diario, reintenta
con espera creciente ante errores transitorios y se detiene sola, dejando un
archivo `STOP`, ante cupo de publicaciones, lectura fallida de un alta, cuenta
distinta o conexión inválida. Mientras corre impide que Windows suspenda la PC.

La renovación no usa el navegador. `scripts/vintage-local/renew.mjs` inicia sesión
en el portal de SBS (`ag.sbs.com.ar`, usuario y clave guardados en `private/sbs.json`
por el instalador) y baja "Lista completa de disponibles" (`/Home/AllPriceList`);
sin ese archivo usa el Excel público, que SBS dejó de actualizar en agosto de 2026.
Lo lee con el mismo lector que el panel, revoca la conexión anterior, carga el
stock en D1 y pide una conexión nueva a `POST /operations/vintage-renew`.

Con cada lista fresca, `scripts/vintage-local/stock-sync.mjs` compara las
publicaciones creadas por la campaña con la lista: lo que ya no viene o no tiene
stock se **pausa** en Mercado Libre, y lo que vuelve se reactiva sólo si la pausa fue
de esta sincronización o por agotamiento (una pausa manual queda manual). Nunca
cierra publicaciones, no toca ítems de otro vendedor o SKU, y si faltan más del 30 %
de los títulos considera la lista incompleta y no pausa nada. En el mismo paso ajusta el
precio de cada libro con stock al que da la política aprobada con el precio de lista
de ese día (sube o baja, nunca por debajo de UYU 1.600); un cambio de más del doble o a
menos de la mitad se considera dato sospechoso y no se aplica. Sólo vuelve a leer y
escribir los libros cuyo precio calculado cambió. Se controla con
`--stock-sync off|report|pause_only|pause_and_reactivate` (por defecto, pausar y
reactivar); el resultado queda en `stock-sync.json`. Esa ruta exige el secreto `VINTAGE_RENEW_SECRET`
(Cloudflare Pages, mínimo 32 caracteres); sin él responde 503. Sólo acepta las
acciones `begin`, `import`, `commit`, `renew`, `revoke` y `status` sobre el lote de
Vintage: no recibe vendedor, política ni `run_id`. `renew` repite exactamente lo
que hace el panel (`start` más la emisión de la conexión) y rechaza un ejecutor
con actividad en los últimos dos minutos; `revoke` pausa el lote y anula la clave.

Instalación en Windows, una sola vez:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\vintage-local\install-autorun.ps1 -NotifyUrl https://ntfy.sh/<tu-tema>
```

La tarea ejecuta `run.cmd`, que llama a `scripts/vintage-local/launch.cmd` del repo:
reinicia el supervisor si se cae y cuando sale para recargar código nuevo, y en cada
ciclo el supervisor hace `git pull --ff-only` de su rama, así los arreglos llegan solos.
`stop.cmd` deja el archivo `STOP`; el motor termina el libro en curso y todo se detiene
en menos de un minuto. Cada día manda un aviso "funcionando" con el total publicado; los
errores que necesitan una persona (clave de SBS rechazada, secreto del sitio) avisan una
vez y esperan en vez de reintentar sin fin. El workflow `Vintage status (read-only)` lee
el progreso desde D1 de producción sin acceso a la PC.

Pide el secreto y lo guarda en `%LOCALAPPDATA%\Amado\VintagePublisher\private`,
desactiva la suspensión con corriente, registra la tarea programada
`AmadoVintagePublisher` (arranca al iniciar sesión y se reinicia sola) y crea
`stop.cmd` y `start.cmd` en la carpeta de estado. Los avisos van a `-NotifyUrl`
(un tema de ntfy en el celular o cualquier webhook JSON). Registros diarios en
`logs/`, con 14 días de retención; `status.json` tiene el estado actual.
