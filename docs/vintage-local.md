# Publicador local de Vintage

`scripts/vintage_local.py` runs on the owner's PC without a browser or queue.
Python owns the OS process lock and supervises the existing Node publication
engine, rather than duplicating its validated metadata, shipping and pricing code.
Node 22.13+ (or Node 24) and Python 3 are required; no new packages are needed.

The destination is fixed to seller 2341378249 and app 4741021817925208. Prices
retain the approved policy, a UYU 1,600 floor and 18-day availability. The target
defaults to 1,000 total campaign publications, including the five pilot items.
The seller's existing receipts enforce the server-side daily cap, defined once as
`VINTAGE_DAILY_CAP` in `functions/_shared/meli-vintage-bulk.js` (currently 3,000) and
reported to the engine through the `status` action. Raise it in steps (1,000 → 3,000 →
10,000), reviewing the cases flagged for review and any 429 or moderation signal before
each increase. Deploying the new value is a production change and needs owner approval.

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
`stopped_item_readback_failed`. Restart with the same directory to preserve progress. A hard
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

## Pausing sold-out books (`--sync-stock`)

In SBS's Excel a sold-out book simply disappears (`Disponibilidad` is only `+2`, `2` or `1`, never `0`).
`scripts/vintage-local/stock-sync.mjs` compares the ISBNs Vintage has published (local receipts) with the
current Excel and pauses on Mercado Libre the ones SBS no longer offers. It is modelled on
`worker-sync/publication-stock-sync.js` (Amado Libros), which it does not use or change.

```powershell
python scripts/vintage_local.py --excel '<new SBS Excel>' --connection '<connection>' --sync-stock report --sync-only
python scripts/vintage_local.py --excel '<new SBS Excel>' --connection '<connection>' --sync-stock pause_and_reactivate
```

- `report` only lists what it would pause. `pause_only` pauses. `pause_and_reactivate` also brings back a
  book that returns to the Excel, but only one this process paused (or one left at quantity 0): a manual
  pause stays manual. `--sync-only` stops after the sync; without it publishing continues afterwards.
- Pausing is immediate (no grace period) because delivery is 18 days. Nothing is ever closed or deleted.
- Nothing is paused for a stale file (over 24 h), a workbook with fewer than 40,000 rows, a file older than the
  last synced one, or when more than 10% of the published books disappear at once (looks like a broken file:
  it only reports). Only items of seller 2341378249 with SKU `AMADO-AR-<ISBN>` are touched.
- A 429 stops the sync and the pending items are retried on the next run. Progress lives in the local table
  `ml_vintage_stock_sync`; `stock-sync-report.json` in the state folder lists the paused/reactivated ISBNs.
- It needs the connection and the process lock, so run it when the publisher is stopped (for example at
  each restart with the new daily Excel).

## Slowing the request clock (`VINTAGE_SPACING_MS`)

The shared request clock leaves 2,000 ms between Mercado Libre calls. If 429s cluster, set the environment
variable `VINTAGE_SPACING_MS` (for example `3500`) before starting the publisher to leave more room. It can
only slow the clock: values under 2,000 or over 60,000 make the process refuse to start.
