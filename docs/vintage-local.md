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
after the create). After that bounded wait the book is deferred for reconciliation, without another
create. A different seller, ISBN, price, quantity, currency, availability or moderation reason still
stops the process with `stopped_item_readback_failed`. Restart with the same directory to preserve progress. A hard
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

## Request measurement and catalog budget

`request-counts.jsonl`, next to `rate-limit-events.jsonl`, contains additive
`minute_delta` rows by method/endpoint and `book_delta` rows for the books processed
in that tick. The book key is kept only in memory. Neither file contains ISBNs,
seller/item/product IDs, query strings, request bodies, headers or credentials.
Only the sanitized `Retry-After` value is kept for a real 429. No new dependency is needed.

Network attempts, transport failures and cache hits are counted separately **inside**
the limiter, so cached categories/attributes do not inflate API consumption. Startup
inventory and account checks are in the minute totals; later reconciliation has its
own book observation. The per-new-book mean covers the tick that sent `POST /items`,
not all future reconciliation calls. Broker traffic and OAuth refreshes performed
on the server are outside these local ML data-endpoint counters.
If `status.json` reports `telemetry_write_failed`, fix the logging problem before
using that window as complete evidence; publication results are preserved.

Summarize the actual records after the next authorized restart:

```powershell
node scripts/vintage-local/metrics.mjs --directory "$env:LOCALAPPDATA/Amado/VintagePublisher"
```

The global clock remains **2 seconds**. `/products/search` also has a persistent
**5-second** minimum between searches, a conservative budget of our own, not a claim
about Mercado Libre's quota. Strikes are per method/endpoint. Only a successful
network response on that same endpoint clears them; a cache hit or a successful
`/users/me` cannot clear search strikes. Existing global cooldowns remain honored.

Positive exact-ISBN searches and active book-product details are cached for five
minutes. Empty/ambiguous searches, inactive products and failures are not cached.
Static categories/attributes retain their 30-minute cache. Identity, item readback,
fees and validations are never cached. This mainly saves retries: a new ISBN still
requires its own catalog search, even when its final `catalog_listing` is false,
because prepare uses the result to verify the edition and obtain required metadata.

No production requests were sent to benchmark the new code. The fake-server trace
over the real API implementation gives 15 calls with cold metadata and 12 for the
next unique ISBN with warm categories/attributes. The production mean remains to
be measured. Twelve calls with a 2-second global spacing imply at most about 150
new books/hour in a sustained stream before other overhead; these changes do not
establish a capacity of 250 books/hour.

See `docs/vintage-api-diagnostic-2026-10-18.md` for the evidence, quota-request draft,
app separation plan and activation notes. Keep this branch isolated until the owner
reviews it; neither an existing publicador nor PR #458/#459 is restarted or merged
by preparing these changes.
