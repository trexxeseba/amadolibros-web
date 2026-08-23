#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="${GSC_BQ_PROJECT_ID:-amado-libros-analytics}"
EXPECTED_PROJECT_NUMBER="${GSC_BQ_PROJECT_NUMBER:-667747565315}"
DATASET_ID="${GSC_BQ_DATASET_ID:-searchconsole}"
MEMBER="serviceAccount:ga4-reporter@amado-libros-analytics.iam.gserviceaccount.com"
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
bq --project_id="$PROJECT_ID" show --format=prettyjson "$DATASET_REF" > "$OUTPUT_DIR/dataset.json"
ACCESS_TOKEN="$(gcloud auth print-access-token)"
POLICY_URL="https://bigquery.googleapis.com/bigquery/v2/projects/${PROJECT_ID}/datasets/${DATASET_ID}"

get_policy() {
  local output_file="$1"
  curl --fail-with-body --silent --show-error --request POST --header "Authorization: Bearer $ACCESS_TOKEN" --header 'Content-Type: application/json' --data '{"options":{"requestedPolicyVersion":3}}' "${POLICY_URL}:getIamPolicy" > "$output_file"
}

get_policy "$OUTPUT_DIR/policy-before.json"

binding_exists() {
  local file="$1"
  jq -e --arg role "$ROLE" --arg member "$MEMBER" '
    any(.bindings[]?; .role == $role and ((.members // []) | index($member) != null))
  ' "$file" >/dev/null
}

if binding_exists "$OUTPUT_DIR/policy-before.json"; then
  echo "El binding exacto ya existe; ejecución idempotente."
else
  jq --arg role "$ROLE" --arg member "$MEMBER" '
    .bindings = (
      [(.bindings // [])[] | select(.role != $role)] +
      [{
        role: $role,
        members: (([(.bindings // [])[] | select(.role == $role) | .members[]?] + [$member]) | unique)
      }]
    )
    | {policy: .}
  ' "$OUTPUT_DIR/policy-before.json" > "$OUTPUT_DIR/set-policy-request.json"

  curl --fail-with-body --silent --show-error --request POST --header "Authorization: Bearer $ACCESS_TOKEN" --header 'Content-Type: application/json' --data-binary "@$OUTPUT_DIR/set-policy-request.json" "${POLICY_URL}:setIamPolicy" > "$OUTPUT_DIR/set-policy-response.json"
fi

get_policy "$OUTPUT_DIR/policy-after.json"
if ! binding_exists "$OUTPUT_DIR/policy-after.json"; then
  echo "ERROR: no se confirmó el binding exacto en el dataset." >&2
  exit 5
fi

{
  echo "# GSC BigQuery dataset reader grant"
  echo
  echo "- Project: $PROJECT_ID ($PROJECT_NUMBER)"
  echo "- Dataset: $DATASET_ID"
  echo "- Member: $MEMBER"
  echo "- Role: $ROLE"
  echo "- Scope: dataset only"
  echo "- Web/Worker deploy: no"
  echo "- Production code change: no"
  echo
  echo "El binding exacto quedó confirmado en la política IAM del dataset."
} > "$OUTPUT_DIR/summary.md"

cat "$OUTPUT_DIR/summary.md"
