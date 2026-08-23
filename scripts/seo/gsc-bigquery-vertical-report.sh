#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="${GSC_BQ_PROJECT_ID:-amado-libros-analytics}"
EXPECTED_PROJECT_NUMBER="${GSC_BQ_PROJECT_NUMBER:-667747565315}"
DATASET_ID="${GSC_BQ_DATASET_ID:-searchconsole}"
SITE_URL="${GSC_BQ_SITE_URL:-sc-domain:amadolibros.com}"
OUTPUT_DIR="${GSC_BQ_OUTPUT_DIR:-artifacts/gsc-bigquery-verticals}"
MIN_IMPRESSIONS="${GSC_BQ_MIN_IMPRESSIONS:-3}"
MAX_ROWS="${GSC_BQ_MAX_ROWS:-250000}"
TABLE="${PROJECT_ID}.${DATASET_ID}.searchdata_url_impression"
TABLE_REF="${PROJECT_ID}:${DATASET_ID}.searchdata_url_impression"

for command in gcloud bq jq node mktemp; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: falta el comando requerido: $command" >&2
    exit 2
  fi
done

for value_name in MIN_IMPRESSIONS MAX_ROWS; do
  value="${!value_name}"
  if ! [[ "$value" =~ ^[1-9][0-9]*$ ]]; then
    echo "ERROR: $value_name debe ser un entero positivo." >&2
    exit 2
  fi
done

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ "$PROJECT_NUMBER" != "$EXPECTED_PROJECT_NUMBER" ]]; then
  echo "ERROR: projectNumber inesperado para $PROJECT_ID: $PROJECT_NUMBER" >&2
  exit 3
fi

mkdir -p "$OUTPUT_DIR"
RAW_ROWS="$(mktemp)"
trap 'rm -f "$RAW_ROWS"' EXIT

# `bq show` y `bq head` usan lectura de metadatos/tabledata. No crean jobs,
# tablas ni vistas y permiten auditar el export sin bigquery.jobs.create.
bq --project_id="$PROJECT_ID" show --format=json "$TABLE_REF" \
  | sed -n '/^[[:space:]]*{/,$p' \
  > "$OUTPUT_DIR/table-metadata.json"
jq -e 'type == "object" and (.numRows != null)' "$OUTPUT_DIR/table-metadata.json" >/dev/null
ROW_COUNT="$(jq -r '.numRows // "0"' "$OUTPUT_DIR/table-metadata.json")"

if ! [[ "$ROW_COUNT" =~ ^[0-9]+$ ]] || [[ "$ROW_COUNT" -eq 0 ]]; then
  echo "ERROR: $TABLE no tiene filas disponibles." >&2
  exit 4
fi
if [[ "$ROW_COUNT" -gt "$MAX_ROWS" ]]; then
  echo "ERROR: $TABLE tiene $ROW_COUNT filas y supera el límite seguro de $MAX_ROWS; no se generará un informe parcial." >&2
  exit 5
fi

bq --project_id="$PROJECT_ID" head \
  --max_rows="$ROW_COUNT" \
  --format=json \
  "$TABLE_REF" \
  | sed -n '/^[[:space:]]*\[/,$p' \
  > "$RAW_ROWS"
jq -e 'type == "array"' "$RAW_ROWS" >/dev/null

FETCHED_ROWS="$(jq 'length' "$RAW_ROWS")"
if [[ "$FETCHED_ROWS" -ne "$ROW_COUNT" ]]; then
  echo "ERROR: lectura incompleta de $TABLE: esperadas=$ROW_COUNT, recibidas=$FETCHED_ROWS." >&2
  exit 6
fi

node scripts/seo/gsc-bigquery-vertical-analysis.mjs \
  --input "$RAW_ROWS" \
  --output "$OUTPUT_DIR" \
  --site "$SITE_URL" \
  --table "$TABLE" \
  --min-impressions "$MIN_IMPRESSIONS" \
  --table-row-count "$ROW_COUNT"
