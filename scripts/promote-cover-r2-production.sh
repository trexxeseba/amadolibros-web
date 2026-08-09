#!/usr/bin/env bash
set -euo pipefail

SOURCE_BUCKET="${SOURCE_BUCKET:-amadolibros-images-preview}"
TARGET_BUCKET="${TARGET_BUCKET:-amadolibros-images-production}"
WRANGLER_VERSION="${WRANGLER_VERSION:-4.107.0}"

if npx "wrangler@$WRANGLER_VERSION" r2 bucket info "$TARGET_BUCKET" --json \
  >/tmp/cover-r2-bucket.json 2>/tmp/cover-r2-bucket.err; then
  echo "Bucket productivo ya existe."
else
  npx "wrangler@$WRANGLER_VERSION" r2 bucket create "$TARGET_BUCKET"
fi

npx "wrangler@$WRANGLER_VERSION" r2 object get \
  "$SOURCE_BUCKET/covers/v1/manifest.json" \
  --remote --file /tmp/cover-r2-manifest.json

node <<'NODE'
const fs = require('node:fs');
const manifest = JSON.parse(fs.readFileSync('/tmp/cover-r2-manifest.json', 'utf8'));
const entries = Object.values(manifest.entries || {});
if (manifest.schema_version !== 1 || entries.length !== 20) {
  throw new Error(`Manifest fuente inválido: ${entries.length} entradas`);
}
const rows = entries.map(entry => {
  const current = entry?.current || {};
  const match = /^covers\/v1\/objects\/([a-f0-9]{64})\.(jpg|png|webp)$/.exec(current.object_key || '');
  if (!match || current.sha256 !== match[1]) throw new Error(`Objeto inválido: ${current.object_key}`);
  const expectedMime = `image/${match[2] === 'jpg' ? 'jpeg' : match[2]}`;
  if (current.mime !== expectedMime) throw new Error(`MIME inválido: ${current.object_key}`);
  return [current.object_key, current.mime, current.sha256].join('\t');
});
if (new Set(rows.map(row => row.split('\t')[0])).size !== 20) {
  throw new Error('El manifest contiene objetos duplicados.');
}
fs.writeFileSync('/tmp/cover-r2-objects.tsv', `${rows.join('\n')}\n`);
NODE

while IFS=$'\t' read -r OBJECT_KEY MIME SHA; do
  EXT="${OBJECT_KEY##*.}"
  SOURCE_FILE="/tmp/cover-r2-source-$SHA.$EXT"
  VERIFY_FILE="/tmp/cover-r2-verify-$SHA.$EXT"

  npx "wrangler@$WRANGLER_VERSION" r2 object get \
    "$SOURCE_BUCKET/$OBJECT_KEY" --remote --file "$SOURCE_FILE"
  ACTUAL_SHA="$(sha256sum "$SOURCE_FILE" | cut -d' ' -f1)"
  if [ "$ACTUAL_SHA" != "$SHA" ]; then
    echo "SHA fuente inválido para $OBJECT_KEY"
    exit 1
  fi

  npx "wrangler@$WRANGLER_VERSION" r2 object put \
    "$TARGET_BUCKET/$OBJECT_KEY" --remote --file "$SOURCE_FILE" \
    --content-type "$MIME" --cache-control 'public, max-age=31536000, immutable'
  npx "wrangler@$WRANGLER_VERSION" r2 object get \
    "$TARGET_BUCKET/$OBJECT_KEY" --remote --file "$VERIFY_FILE"
  PROMOTED_SHA="$(sha256sum "$VERIFY_FILE" | cut -d' ' -f1)"
  if [ "$PROMOTED_SHA" != "$SHA" ]; then
    echo "SHA productivo inválido para $OBJECT_KEY"
    exit 1
  fi
  rm -f "$SOURCE_FILE" "$VERIFY_FILE"
done < /tmp/cover-r2-objects.tsv

# R2 no ofrece una transacción conjunta entre objetos y manifest. El manifest
# se publica último: un corte puede dejar un objeto huérfano, nunca una portada
# declarada como válida sin que su objeto haya sido verificado antes.
npx "wrangler@$WRANGLER_VERSION" r2 object put \
  "$TARGET_BUCKET/covers/v1/manifest.json" --remote \
  --file /tmp/cover-r2-manifest.json \
  --content-type application/json --cache-control no-store
npx "wrangler@$WRANGLER_VERSION" r2 object get \
  "$TARGET_BUCKET/covers/v1/manifest.json" --remote \
  --file /tmp/cover-r2-production-manifest.json
cmp /tmp/cover-r2-manifest.json /tmp/cover-r2-production-manifest.json
echo "Promoción R2: 20 objetos verificados y manifest publicado último."
