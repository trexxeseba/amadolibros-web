#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="${GSC_BQ_PROJECT_ID:-amado-libros-analytics}"
EXPECTED_PROJECT_NUMBER="${GSC_BQ_PROJECT_NUMBER:-667747565315}"
DATASET_ID="${GSC_BQ_DATASET_ID:-searchconsole}"
REPORTER_EMAIL="ga4-reporter@amado-libros-analytics.iam.gserviceaccount.com"
MEMBER="serviceAccount:${REPORTER_EMAIL}"
ROLE="roles/bigquery.dataViewer"
OUTPUT_DIR="${GSC_BQ_OUTPUT_DIR:-artifacts/gsc-bigquery-dataset-reader-grant}"
DATASET_REF="${PROJECT_ID}:${DATASET_ID}"

for command in gcloud bq curl jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: falta el comando requerido: $command" >&2
    exit 2
  fi
done

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ "$PROJECT_ID" != "amado-libros-analytics" || "$PROJECT_NUMBER" != "$EXPECTED_PROJECT_NUMBER" ]]; then
  echo "ERROR: proyecto inesperado: $PROJECT_ID ($PROJECT_NUMBER)." >&2
  exit 3
fi
if [[ "$DATASET_ID" != "searchconsole" ]]; then
  echo "ERROR: dataset inesperado: $DATASET_ID." >&2
  exit 4
fi

mkdir -p "$OUTPUT_DIR"
gcloud config list --format=yaml > "$OUTPUT_DIR/gcloud-context.yaml"
bq --project_id="$PROJECT_ID" show --format=prettyjson "$DATASET_REF" > "$OUTPUT_DIR/dataset-before.json"
ACCESS_TOKEN="$(gcloud auth print-access-token)"
DATASET_URL="https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/datasets/${DATASET_ID}"

binding_exists() {
  local file="$1"
  jq -e --arg email "$REPORTER_EMAIL" '
    any(.access[]?; .role == "READER" and .userByEmail == $email)
  ' "$file" >/dev/null
}

if binding_exists "$OUTPUT_DIR/dataset-before.json"; then
  echo "El binding exacto ya existe; ejecución idempotente."
else
  ETAG="$(jq -r '.etag // empty' "$OUTPUT_DIR/dataset-before.json")"
  if [[ -z "$ETAG" ]]; then
    echo "ERROR: el dataset no devolvió etag; no se modifica el ACL." >&2
    exit 5
  fi

  jq --arg email "$REPORTER_EMAIL" '
    {access: ((.access // []) + [{role: "READER", userByEmail: $email}])}
  ' "$OUTPUT_DIR/dataset-before.json" > "$OUTPUT_DIR/dataset-patch-request.json"

  curl --fail-with-body --silent --show-error --request PATCH --header "Authorization: Bearer $ACCESS_TOKEN" --header 'Content-Type: application/json' --header "If-Match: $ETAG" --data-binary "@$OUTPUT_DIR/dataset-patch-request.json" "${DATASET_URL}?updateMode=UPDATE_ACL" > "$OUTPUT_DIR/dataset-patch-response.json"
fi

bq --project_id="$PROJECT_ID" show --format=prettyjson "$DATASET_REF" > "$OUTPUT_DIR/dataset-after.json"
if ! binding_exists "$OUTPUT_DIR/dataset-after.json"; then
  echo "ERROR: no se confirmó el binding exacto en el dataset." >&2
  exit 6
fi

{
  echo "# GSC BigQuery dataset reader grant"
  echo
  echo "- Project: $PROJECT_ID ($PROJECT_NUMBER)"
  echo "- Dataset: $DATASET_ID"
  echo "- Member: $MEMBER"
  echo "- Effective role: $ROLE (BigQuery dataset ACL READER)"
  echo "- Scope: dataset only"
  echo "- Web/Worker deploy: no"
  echo "- Production code change: no"
  echo
  echo "El binding exacto quedó confirmado en el ACL del dataset."
} > "$OUTPUT_DIR/summary.md"

cat "$OUTPUT_DIR/summary.md"
