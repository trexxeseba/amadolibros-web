#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ID="${GSC_BQ_PROJECT_ID:-amado-libros-analytics}"
EXPECTED_PROJECT_NUMBER="${GSC_BQ_PROJECT_NUMBER:-667747565315}"
DATASET_ID="${GSC_BQ_DATASET_ID:-searchconsole}"
LOCATION="${GSC_BQ_LOCATION:-US}"
SITE_URL="${GSC_BQ_SITE_URL:-sc-domain:amadolibros.com}"
OUTPUT_DIR="${GSC_BQ_OUTPUT_DIR:-artifacts/gsc-bigquery-verticals}"
MIN_IMPRESSIONS="${GSC_BQ_MIN_IMPRESSIONS:-3}"
MAX_BYTES_BILLED="${GSC_BQ_MAX_BYTES_BILLED:-1000000000}"
TABLE="${PROJECT_ID}.${DATASET_ID}.searchdata_url_impression"

for command in gcloud bq jq date; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "ERROR: falta el comando requerido: $command" >&2
    exit 2
  fi
done

if ! [[ "$MIN_IMPRESSIONS" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: GSC_BQ_MIN_IMPRESSIONS debe ser un entero positivo." >&2
  exit 2
fi
if ! [[ "$MAX_BYTES_BILLED" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: GSC_BQ_MAX_BYTES_BILLED debe ser un entero positivo." >&2
  exit 2
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
if [[ "$PROJECT_NUMBER" != "$EXPECTED_PROJECT_NUMBER" ]]; then
  echo "ERROR: projectNumber inesperado para $PROJECT_ID: $PROJECT_NUMBER" >&2
  exit 3
fi

mkdir -p "$OUTPUT_DIR/sql" "$OUTPUT_DIR/28d" "$OUTPUT_DIR/90d"

bq_read() {
  local format="$1"
  local sql_file="$2"
  bq --project_id="$PROJECT_ID" query \
    --quiet \
    --location="$LOCATION" \
    --use_legacy_sql=false \
    --maximum_bytes_billed="$MAX_BYTES_BILLED" \
    --format="$format" < "$sql_file"
}

cat > "$OUTPUT_DIR/sql/availability.sql" <<SQL
SELECT
  CAST(MIN(data_date) AS STRING) AS min_data_date,
  CAST(MAX(data_date) AS STRING) AS max_data_date,
  COUNT(DISTINCT data_date) AS available_days,
  COUNT(*) AS row_count
FROM \`${TABLE}\`
WHERE site_url = '${SITE_URL}'
  AND search_type = 'web'
SQL

bq_read json "$OUTPUT_DIR/sql/availability.sql" > "$OUTPUT_DIR/availability.json"
MIN_DATE="$(jq -r '.[0].min_data_date // empty' "$OUTPUT_DIR/availability.json")"
MAX_DATE="$(jq -r '.[0].max_data_date // empty' "$OUTPUT_DIR/availability.json")"
AVAILABLE_DAYS="$(jq -r '.[0].available_days // "0"' "$OUTPUT_DIR/availability.json")"
ROW_COUNT="$(jq -r '.[0].row_count // "0"' "$OUTPUT_DIR/availability.json")"

if [[ -z "$MIN_DATE" || -z "$MAX_DATE" ]]; then
  echo "ERROR: no hay datos web para $SITE_URL en $TABLE." >&2
  exit 4
fi

write_common_cte() {
  local file="$1"
  local start_date="$2"
  cat > "$file" <<SQL
WITH source AS (
  SELECT
    data_date,
    url,
    query,
    is_anonymized_query,
    country,
    device,
    clicks,
    impressions,
    sum_position,
    LOWER(COALESCE(query, '')) AS query_normalized,
    LOWER(COALESCE(url, '')) AS url_normalized
  FROM \`${TABLE}\`
  WHERE site_url = '${SITE_URL}'
    AND search_type = 'web'
    AND data_date BETWEEN DATE('${start_date}') AND DATE('${MAX_DATE}')
), classified AS (
  SELECT
    *,
    CASE
      WHEN REGEXP_CONTAINS(query_normalized, r'(tarot|or[áa]culo|rider[ -]?waite|marsella|baraja adivinatoria|mazo de cartas)')
        OR REGEXP_CONTAINS(url_normalized, r'(/libros/esoterismo-tarot|tarot|oraculo|oráculo|rider-waite|marsella)')
        THEN 'tarot'
      WHEN REGEXP_CONTAINS(query_normalized, r'(biblia|reina[ -]?valera|rvr[ -]?(1960|60)|rvc|nvi|ntv|dhh|jerusal[ée]n|latinoamericana|nuevo testamento)')
        OR REGEXP_CONTAINS(url_normalized, r'(biblia|reina-valera|rvr-?(1960|60)|jerusalen|latinoamericana|nuevo-testamento)')
        THEN 'biblias'
      ELSE NULL
    END AS vertical
  FROM source
)
SQL
}

run_window() {
  local window="$1"
  local start_date
  local window_dir="$OUTPUT_DIR/${window}d"
  local prefix="$OUTPUT_DIR/sql/${window}d"
  start_date="$(date -u -d "$MAX_DATE -$((window - 1)) days" +%F)"

  write_common_cte "$prefix-summary.sql" "$start_date"
  cat >> "$prefix-summary.sql" <<'SQL'
SELECT
  vertical,
  SUM(clicks) AS clicks,
  SUM(impressions) AS impressions,
  SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
  SAFE_DIVIDE(SUM(sum_position), SUM(impressions)) + 1 AS average_position,
  COUNT(DISTINCT url) AS urls,
  COUNT(DISTINCT IF(is_anonymized_query, NULL, query)) AS queries,
  COUNT(DISTINCT data_date) AS data_days
FROM classified
WHERE vertical IS NOT NULL
GROUP BY vertical
ORDER BY vertical
SQL

  write_common_cte "$prefix-queries.sql" "$start_date"
  cat >> "$prefix-queries.sql" <<SQL
SELECT
  vertical,
  query,
  country,
  device,
  SUM(clicks) AS clicks,
  SUM(impressions) AS impressions,
  SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
  SAFE_DIVIDE(SUM(sum_position), SUM(impressions)) + 1 AS average_position
FROM classified
WHERE vertical IS NOT NULL
  AND NOT is_anonymized_query
  AND query IS NOT NULL
  AND query != ''
GROUP BY vertical, query, country, device
HAVING SUM(impressions) >= ${MIN_IMPRESSIONS}
  AND SAFE_DIVIDE(SUM(sum_position), SUM(impressions)) + 1 BETWEEN 4 AND 20
ORDER BY impressions DESC, clicks DESC, average_position ASC
LIMIT 1000
SQL

  write_common_cte "$prefix-pages.sql" "$start_date"
  cat >> "$prefix-pages.sql" <<'SQL'
SELECT
  vertical,
  url,
  SUM(clicks) AS clicks,
  SUM(impressions) AS impressions,
  SAFE_DIVIDE(SUM(clicks), SUM(impressions)) AS ctr,
  SAFE_DIVIDE(SUM(sum_position), SUM(impressions)) + 1 AS average_position,
  COUNT(DISTINCT IF(is_anonymized_query, NULL, query)) AS queries
FROM classified
WHERE vertical IS NOT NULL
  AND url IS NOT NULL
  AND url != ''
GROUP BY vertical, url
ORDER BY impressions DESC, clicks DESC
LIMIT 2000
SQL

  write_common_cte "$prefix-cannibalization.sql" "$start_date"
  cat >> "$prefix-cannibalization.sql" <<SQL
, query_page AS (
  SELECT
    vertical,
    query,
    url,
    SUM(clicks) AS clicks,
    SUM(impressions) AS impressions,
    SUM(sum_position) AS sum_position
  FROM classified
  WHERE vertical IS NOT NULL
    AND NOT is_anonymized_query
    AND query IS NOT NULL
    AND query != ''
    AND url IS NOT NULL
    AND url != ''
  GROUP BY vertical, query, url
)
SELECT
  vertical,
  query,
  COUNT(*) AS url_count,
  SUM(clicks) AS clicks,
  SUM(impressions) AS impressions,
  SAFE_DIVIDE(SUM(sum_position), SUM(impressions)) + 1 AS average_position,
  STRING_AGG(url, ' | ' ORDER BY impressions DESC LIMIT 5) AS top_urls
FROM query_page
GROUP BY vertical, query
HAVING COUNT(*) > 1
  AND SUM(impressions) >= ${MIN_IMPRESSIONS}
ORDER BY impressions DESC, url_count DESC
LIMIT 500
SQL

  for report in summary queries pages cannibalization; do
    bq_read json "$prefix-${report}.sql" > "$window_dir/vertical-${report}.json"
    bq_read csv "$prefix-${report}.sql" > "$window_dir/vertical-${report}.csv"
  done

  jq -n \
    --arg window_days "$window" \
    --arg start_date "$start_date" \
    --arg end_date "$MAX_DATE" \
    --arg available_min_date "$MIN_DATE" \
    --arg available_max_date "$MAX_DATE" \
    --arg available_days "$AVAILABLE_DAYS" \
    '{
      windowDays: ($window_days | tonumber),
      requestedRange: {startDate: $start_date, endDate: $end_date},
      availableRange: {minDate: $available_min_date, maxDate: $available_max_date, days: ($available_days | tonumber)}
    }' > "$window_dir/metadata.json"
}

run_window 28
run_window 90

{
  echo '# GSC BigQuery — Tarot y Biblias'
  echo
  echo "- Propiedad: \`$SITE_URL\`"
  echo "- Tabla: \`$TABLE\`"
  echo "- Datos disponibles: **$MIN_DATE a $MAX_DATE** ($AVAILABLE_DAYS días; $ROW_COUNT filas web)"
  echo '- Ventanas solicitadas: 28 y 90 días, recortadas automáticamente a los datos realmente disponibles.'
  echo "- Oportunidades: posición 4–20 y al menos $MIN_IMPRESSIONS impresiones."
  echo "- Límite de costo por consulta: $MAX_BYTES_BILLED bytes."
  echo
  for window in 28 90; do
    echo "## Ventana ${window} días"
    echo
    if [[ "$(jq 'length' "$OUTPUT_DIR/${window}d/vertical-summary.json")" -eq 0 ]]; then
      echo '- Sin filas clasificadas para Tarot o Biblias.'
    else
      jq -r '.[] | "- \(.vertical): \(.clicks) clics, \(.impressions) impresiones, CTR \((.ctr * 10000 | round) / 100)%, posición media \((.average_position * 10 | round) / 10), \(.urls) URLs, \(.data_days) días con datos."' \
        "$OUTPUT_DIR/${window}d/vertical-summary.json"
    fi
    echo
    echo "- Queries accionables: $(jq 'length' "$OUTPUT_DIR/${window}d/vertical-queries.json")"
    echo "- Posibles canibalizaciones: $(jq 'length' "$OUTPUT_DIR/${window}d/vertical-cannibalization.json")"
    echo
  done
  echo '> Informe de sólo lectura. No modifica Search Console, BigQuery, la web, Merchant ni producción.'
} > "$OUTPUT_DIR/summary.md"

cat "$OUTPUT_DIR/summary.md"

