#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="${GSC_BQ_PROJECT_ID:-amado-libros-analytics}"
EXPECTED_PROJECT_NUMBER="${GSC_BQ_PROJECT_NUMBER:-667747565315}"
DATASET_ID="${GSC_BQ_DATASET_ID:-searchconsole}"
MEMBER="serviceAccount:ga4-reporter@amado-libros-analytics.iam.gserviceaccount.com"
ROLE="roles/bigquery.dataViewer"
OUTPUT_DIR="${GSC_BQ_OUTPUT_DIR:-artifacts/gsc-bigquery-dataset-reader-grant}"
DATASET_REF="${PROJECT_ID}:${DATASET_ID}"

for command in gcloud bq jq; do
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
bq --project_id="$PROJECT_ID" show --format=prettyjson "$DATASET_REF" > "$OUTPUT_DIR/dataset.json"
bq --project_id="$PROJECT_ID" get-iam-policy --format=prettyjson "$DATASET_REF" > "$OUTPUT_DIR/policy-before.json"

binding_exists() {
  local file="$1"
  jq -e --arg role "$ROLE" --arg member "$MEMBER" '
    any(.bindings[]?; .role == $role and ((.members // []) | index($member) != null))
  ' "$file" >/dev/null
}

if binding_exists "$OUTPUT_DIR/policy-before.json"; then
  echo "El binding exacto ya existe; ejecución idempotente."
else
  bq --project_id="$PROJECT_ID" add-iam-policy-binding     --member="$MEMBER"     --role="$ROLE"     "$DATASET_REF" >/dev/null
fi

bq --project_id="$PROJECT_ID" get-iam-policy --format=prettyjson "$DATASET_REF" > "$OUTPUT_DIR/policy-after.json"
if ! binding_exists "$OUTPUT_DIR/policy-after.json"; then
  echo "ERROR: no se confirmó el binding exacto en el dataset." >&2
  exit 5
fi

cat > "$OUTPUT_DIR/summary.md" <<EOF
# GSC BigQuery dataset reader grant

- Project: `$PROJECT_ID` (`$PROJECT_NUMBER`)
- Dataset: `$DATASET_ID`
- Member: `$MEMBER`
- Role: `$ROLE`
- Scope: dataset only
- Web/Worker deploy: no
- Production code change: no

El binding exacto quedó confirmado en la política IAM del dataset.
EOF

cat "$OUTPUT_DIR/summary.md"
