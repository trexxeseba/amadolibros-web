#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="${GSC_BQ_PROJECT_ID:-amado-libros-analytics}"
EXPECTED_PROJECT_NUMBER="${GSC_BQ_PROJECT_NUMBER:-667747565315}"
DATASET_ID="${GSC_BQ_DATASET_ID:-searchconsole}"
CONSTRAINT="iam.allowedPolicyMemberDomains"
EXPORT_MEMBER="serviceAccount:search-console-data-export@system.gserviceaccount.com"
REPORTER_MEMBER="serviceAccount:ga4-reporter@amado-libros-analytics.iam.gserviceaccount.com"
TARGET_DATE="${GSC_BQ_TARGET_DATE:-2026-08-18}"
MODE="${GSC_BQ_FIX_MODE:-verify}"
OUTPUT_DIR="${GSC_BQ_OUTPUT_DIR:-artifacts/gsc-bigquery-domain-fix}"

case "$MODE" in
  apply|verify|rollback) ;;
  *)
    echo "ERROR: GSC_BQ_FIX_MODE debe ser apply, verify o rollback; recibido: $MODE" >&2
    exit 2
    ;;
esac

for command in gcloud bq jq; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: falta el comando requerido: $command" >&2
    exit 2
  fi
done

mkdir -p "$OUTPUT_DIR"

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ "$PROJECT_NUMBER" != "$EXPECTED_PROJECT_NUMBER" ]]; then
  echo "ERROR: projectNumber inesperado para $PROJECT_ID: $PROJECT_NUMBER" >&2
  exit 3
fi

echo "project_id=$PROJECT_ID"
echo "project_number=$PROJECT_NUMBER"
echo "mode=$MODE"
echo "target_date=$TARGET_DATE"
gcloud config list --format=yaml > "$OUTPUT_DIR/gcloud-context.yaml"

project_policy_exists=false
if gcloud org-policies describe "$CONSTRAINT" \
  --project="$PROJECT_ID" \
  --format=json > "$OUTPUT_DIR/project-policy-before.json" \
  2> "$OUTPUT_DIR/project-policy-before.err"; then
  project_policy_exists=true
else
  if grep -q 'NOT_FOUND' "$OUTPUT_DIR/project-policy-before.err"; then
    printf '{"status":"NOT_FOUND"}\n' > "$OUTPUT_DIR/project-policy-before.json"
  else
    cat "$OUTPUT_DIR/project-policy-before.err" >&2
    echo "ERROR: no se pudo leer la política de proyecto." >&2
    exit 4
  fi
fi

gcloud org-policies describe "$CONSTRAINT" \
  --project="$PROJECT_ID" \
  --effective \
  --format=json > "$OUTPUT_DIR/effective-policy-before.json"

gcloud projects get-iam-policy "$PROJECT_ID" \
  --format=json > "$OUTPUT_DIR/project-iam-before.json"

policy_is_exact_allow_all() {
  local file="$1"
  jq -e '
    (.spec.inheritFromParent // false) == false and
    (.spec.rules | type == "array") and
    (.spec.rules | length == 1) and
    (.spec.rules[0].allowAll == true) and
    ((.spec.rules[0] | keys_unsorted | sort) == ["allowAll"])
  ' "$file" >/dev/null
}

effective_policy_allows_all() {
  local file="$1"
  jq -e 'any(.spec.rules[]?; .allowAll == true)' "$file" >/dev/null
}

wait_for_effective_allow_all() {
  local attempts="${1:-30}"
  local delay="${2:-30}"
  local attempt
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if gcloud org-policies describe "$CONSTRAINT" \
      --project="$PROJECT_ID" \
      --effective \
      --format=json > "$OUTPUT_DIR/effective-policy-after.json"; then
      if effective_policy_allows_all "$OUTPUT_DIR/effective-policy-after.json"; then
        echo "Política efectiva allowAll=true confirmada en intento $attempt/$attempts."
        return 0
      fi
    fi
    echo "Esperando propagación de Organization Policy ($attempt/$attempts)..."
    sleep "$delay"
  done
  echo "ERROR: la política efectiva no llegó a allowAll=true dentro de la ventana." >&2
  return 1
}

ensure_export_role() {
  local role="$1"
  local iam_file="$OUTPUT_DIR/project-iam-current.json"
  gcloud projects get-iam-policy "$PROJECT_ID" --format=json > "$iam_file"
  if jq -e --arg role "$role" --arg member "$EXPORT_MEMBER" '
    any(.bindings[]?; .role == $role and ((.members // []) | index($member) != null))
  ' "$iam_file" >/dev/null; then
    echo "IAM ya contiene $role para $EXPORT_MEMBER."
    return 0
  fi

  echo "Agregando $role a $EXPORT_MEMBER..."
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="$EXPORT_MEMBER" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
}

if [[ "$MODE" == "apply" ]]; then
  if [[ "$project_policy_exists" == "true" ]]; then
    if policy_is_exact_allow_all "$OUTPUT_DIR/project-policy-before.json"; then
      echo "El override de proyecto ya es exactamente allowAll=true; ejecución idempotente."
    else
      echo "ERROR: ya existe una política de proyecto distinta. No se sobrescribe." >&2
      cat "$OUTPUT_DIR/project-policy-before.json" >&2
      exit 5
    fi
  else
    cat > "$OUTPUT_DIR/policy-applied.yaml" <<EOF
name: projects/${PROJECT_NUMBER}/policies/${CONSTRAINT}
spec:
  inheritFromParent: false
  rules:
  - allowAll: true
EOF

    gcloud org-policies set-policy "$OUTPUT_DIR/policy-applied.yaml" \
      --update-mask=spec \
      --quiet
  fi

  wait_for_effective_allow_all
  ensure_export_role roles/bigquery.jobUser
  ensure_export_role roles/bigquery.dataEditor
elif [[ "$MODE" == "rollback" ]]; then
  if [[ "$project_policy_exists" != "true" ]]; then
    echo "No existe override de proyecto; rollback idempotente."
  elif policy_is_exact_allow_all "$OUTPUT_DIR/project-policy-before.json"; then
    gcloud org-policies delete "$CONSTRAINT" \
      --project="$PROJECT_ID" \
      --quiet
    echo "Override allowAll eliminado; vuelve a heredarse la política superior."
  else
    echo "ERROR: el override existente no coincide exactamente con el creado por este lote; no se elimina." >&2
    exit 6
  fi
else
  if ! effective_policy_allows_all "$OUTPUT_DIR/effective-policy-before.json"; then
    echo "ERROR: verify encontró que la política efectiva no permite todos los miembros." >&2
    exit 7
  fi
fi

if [[ "$MODE" != "rollback" ]]; then
  gcloud org-policies describe "$CONSTRAINT" \
    --project="$PROJECT_ID" \
    --format=json > "$OUTPUT_DIR/project-policy-after.json"
  gcloud org-policies describe "$CONSTRAINT" \
    --project="$PROJECT_ID" \
    --effective \
    --format=json > "$OUTPUT_DIR/effective-policy-after.json"

  if ! policy_is_exact_allow_all "$OUTPUT_DIR/project-policy-after.json"; then
    echo "ERROR: el override persistente final no es exactamente allowAll=true." >&2
    exit 8
  fi
  if ! effective_policy_allows_all "$OUTPUT_DIR/effective-policy-after.json"; then
    echo "ERROR: la política efectiva final no permite al exportador." >&2
    exit 9
  fi
fi

gcloud projects get-iam-policy "$PROJECT_ID" \
  --format=json > "$OUTPUT_DIR/project-iam-after.json"

if [[ "$MODE" != "rollback" ]]; then
  for role in roles/bigquery.jobUser roles/bigquery.dataEditor; do
    if ! jq -e --arg role "$role" --arg member "$EXPORT_MEMBER" '
      any(.bindings[]?; .role == $role and ((.members // []) | index($member) != null))
    ' "$OUTPUT_DIR/project-iam-after.json" >/dev/null; then
      echo "ERROR: falta $role para $EXPORT_MEMBER después de la corrección." >&2
      exit 10
    fi
  done
fi

jq -r --arg member "$REPORTER_MEMBER" '
  [.bindings[]? | select((.members // []) | index($member) != null) | .role] | unique[]
' "$OUTPUT_DIR/project-iam-after.json" > "$OUTPUT_DIR/ga4-reporter-project-roles.txt"

DATASET_EXISTS=false
if bq --project_id="$PROJECT_ID" show --format=prettyjson \
  "$PROJECT_ID:$DATASET_ID" > "$OUTPUT_DIR/dataset.json" 2> "$OUTPUT_DIR/dataset.err"; then
  DATASET_EXISTS=true
fi

TABLES=(ExportLog searchdata_url_impression searchdata_site_impression)
TABLE_SUMMARY="$OUTPUT_DIR/table-summary.tsv"
printf 'table\texists\tnum_rows\ttarget_date_rows\tmax_data_date\n' > "$TABLE_SUMMARY"

for table in "${TABLES[@]}"; do
  table_json="$OUTPUT_DIR/table-${table}.json"
  query_json="$OUTPUT_DIR/query-${table}.json"
  if [[ "$DATASET_EXISTS" == "true" ]] && \
    bq --project_id="$PROJECT_ID" show --format=prettyjson \
      "$PROJECT_ID:$DATASET_ID.$table" > "$table_json" 2> "$OUTPUT_DIR/table-${table}.err"; then
    num_rows="$(jq -r '.numRows // "0"' "$table_json")"
    target_rows="unknown"
    max_date="unknown"
    if bq --project_id="$PROJECT_ID" query \
      --quiet \
      --use_legacy_sql=false \
      --format=json \
      "SELECT COUNTIF(data_date = DATE('${TARGET_DATE}')) AS target_date_rows, CAST(MAX(data_date) AS STRING) AS max_data_date FROM \`${PROJECT_ID}.${DATASET_ID}.${table}\`" \
      > "$query_json" 2> "$OUTPUT_DIR/query-${table}.err"; then
      target_rows="$(jq -r '.[0].target_date_rows // "0"' "$query_json")"
      max_date="$(jq -r '.[0].max_data_date // "null"' "$query_json")"
    fi
    printf '%s\ttrue\t%s\t%s\t%s\n' "$table" "$num_rows" "$target_rows" "$max_date" >> "$TABLE_SUMMARY"
  else
    printf '%s\tfalse\t0\t0\tnull\n' "$table" >> "$TABLE_SUMMARY"
  fi
done

{
  echo "# GSC BigQuery domain fix"
  echo
  echo "- Project: \`$PROJECT_ID\` (\`$PROJECT_NUMBER\`)"
  echo "- Dataset: \`$DATASET_ID\`"
  echo "- Mode: \`$MODE\`"
  echo "- Constraint: \`$CONSTRAINT\`"
  echo "- Export principal: \`$EXPORT_MEMBER\`"
  echo "- Target data date: \`$TARGET_DATE\`"
  echo "- Dataset exists: \`$DATASET_EXISTS\`"
  echo
  echo '```tsv'
  cat "$TABLE_SUMMARY"
  echo '```'
  echo
  echo "The policy correction is complete when the effective project policy is allowAll=true and both required BigQuery roles are present. Search Console can populate rows only on its next retry; zero rows immediately after the fix are not treated as a policy failure."
} > "$OUTPUT_DIR/summary.md"

cat "$OUTPUT_DIR/summary.md"
