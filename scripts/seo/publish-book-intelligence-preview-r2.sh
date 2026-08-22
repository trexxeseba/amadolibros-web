#!/usr/bin/env bash
set -euo pipefail

INPUT_FILE="${1:-artifacts/book-intelligence/enrichment-manifest-1/enrichment-manifest.json}"
BUCKET="${BOOK_INTELLIGENCE_PREVIEW_BUCKET:-amadolibros-catalog}"
PREFIX="book-intelligence/preview/v1"
WRANGLER_VERSION="${WRANGLER_VERSION:-4.107.0}"

if [ ! -s "$INPUT_FILE" ]; then
  echo "Manifest inexistente o vacío: $INPUT_FILE" >&2
  exit 1
fi

node - "$INPUT_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
if (manifest.schema_version !== 1) throw new Error('schema_version inválido');
if (!Array.isArray(manifest.entries) || manifest.entries.length < 1) throw new Error('entries vacío');
if (manifest.counts?.total !== manifest.entries.length) throw new Error('counts.total inconsistente');
if ((manifest.counts.auto_publish || 0) + (manifest.counts.review || 0) + (manifest.counts.hold || 0) !== manifest.entries.length) {
  throw new Error('conteos de decisiones inconsistentes');
}
for (const entry of manifest.entries) {
  if (!/^MLU\d+$/.test(String(entry.product_id || ''))) throw new Error(`product_id inválido: ${entry.product_id}`);
  if (!['auto_publish', 'review', 'hold'].includes(entry.decision)) throw new Error(`decisión inválida: ${entry.decision}`);
  if (entry.decision === 'hold') {
    if (entry.work?.topic_seeds?.length) throw new Error(`hold con temas: ${entry.product_id}`);
    if (Object.keys(entry.edition?.auto_publishable_fields || {}).length) throw new Error(`hold con hechos de edición: ${entry.product_id}`);
  }
  const raw = JSON.stringify(entry).toLowerCase();
  if (raw.includes('"description"') || raw.includes('"summary"') || raw.includes('"author_context"')) {
    throw new Error(`copy externo prohibido: ${entry.product_id}`);
  }
}
NODE

SHA="$(sha256sum "$INPUT_FILE" | cut -d' ' -f1)"
BYTES="$(wc -c < "$INPUT_FILE" | tr -d ' ')"
OBJECT_KEY="$PREFIX/objects/$SHA.json"
POINTER_KEY="$PREFIX/manifest.json"
STAGING_KEY="$PREFIX/staging/manifest-${GITHUB_RUN_ID:-manual}.json"
REMOTE_OBJECT="/tmp/book-intelligence-r2-object.json"
REMOTE_STAGING="/tmp/book-intelligence-r2-staging.json"
REMOTE_POINTER="/tmp/book-intelligence-r2-pointer.json"
POINTER_FILE="/tmp/book-intelligence-preview-pointer.json"

# Objeto content-addressed primero. Puede quedar huérfano ante un corte, pero
# nunca queda anunciado por el puntero si el readback no verifica su SHA.
npx "wrangler@$WRANGLER_VERSION" r2 object put \
  "$BUCKET/$OBJECT_KEY" --remote --file "$INPUT_FILE" \
  --content-type application/json \
  --cache-control 'public, max-age=31536000, immutable'

npx "wrangler@$WRANGLER_VERSION" r2 object get \
  "$BUCKET/$OBJECT_KEY" --remote --file "$REMOTE_OBJECT"
REMOTE_SHA="$(sha256sum "$REMOTE_OBJECT" | cut -d' ' -f1)"
if [ "$REMOTE_SHA" != "$SHA" ]; then
  echo "SHA remoto inválido: esperado=$SHA recibido=$REMOTE_SHA" >&2
  exit 1
fi

node - "$INPUT_FILE" "$POINTER_FILE" "$OBJECT_KEY" "$SHA" "$BYTES" <<'NODE'
const fs = require('node:fs');
const [input, output, objectKey, sha256, bytesRaw] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(input, 'utf8'));
const pointer = {
  schema_version: 1,
  environment: 'preview',
  generated_at: manifest.generated_at || null,
  catalog_version: manifest.catalog_version || null,
  current: {
    object_key: objectKey,
    sha256,
    bytes: Number(bytesRaw),
    counts: manifest.counts,
  },
};
fs.writeFileSync(output, `${JSON.stringify(pointer, null, 2)}\n`);
NODE

# Staging del puntero + readback antes de tocar el puntero estable.
npx "wrangler@$WRANGLER_VERSION" r2 object put \
  "$BUCKET/$STAGING_KEY" --remote --file "$POINTER_FILE" \
  --content-type application/json --cache-control no-store
npx "wrangler@$WRANGLER_VERSION" r2 object get \
  "$BUCKET/$STAGING_KEY" --remote --file "$REMOTE_STAGING"
cmp "$POINTER_FILE" "$REMOTE_STAGING"

# Puntero estable, siempre último. Producción no tiene CATALOG_BUCKET y ningún
# runtime actual conoce este namespace `book-intelligence/preview/v1`.
npx "wrangler@$WRANGLER_VERSION" r2 object put \
  "$BUCKET/$POINTER_KEY" --remote --file "$POINTER_FILE" \
  --content-type application/json --cache-control no-store
npx "wrangler@$WRANGLER_VERSION" r2 object get \
  "$BUCKET/$POINTER_KEY" --remote --file "$REMOTE_POINTER"
cmp "$POINTER_FILE" "$REMOTE_POINTER"

node - "$REMOTE_POINTER" "$REMOTE_OBJECT" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [pointerPath, objectPath] = process.argv.slice(2);
const pointer = JSON.parse(fs.readFileSync(pointerPath, 'utf8'));
const object = JSON.parse(fs.readFileSync(objectPath, 'utf8'));
const sha = crypto.createHash('sha256').update(fs.readFileSync(objectPath)).digest('hex');
if (pointer.environment !== 'preview') throw new Error('pointer no es Preview');
if (pointer.current.sha256 !== sha) throw new Error('pointer SHA no coincide con objeto');
if (pointer.current.object_key !== `book-intelligence/preview/v1/objects/${sha}.json`) throw new Error('object_key fuera del namespace');
if (pointer.current.counts.total !== object.entries.length) throw new Error('pointer total inconsistente');
console.log(JSON.stringify({
  environment: pointer.environment,
  object_key: pointer.current.object_key,
  sha256: pointer.current.sha256,
  bytes: pointer.current.bytes,
  counts: pointer.current.counts,
}, null, 2));
NODE

echo "Preview R2 publicado: $BUCKET/$POINTER_KEY -> $OBJECT_KEY ($BYTES bytes)."
