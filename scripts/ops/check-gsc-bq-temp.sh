#!/usr/bin/env bash
set +e
PROJECT='amado-libros-analytics'
DATASET='searchconsole'
OUT=/tmp/gsc-bq-status.txt
: > "$OUT"
echo "checked_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$OUT"
echo "bq_path=$(command -v bq || echo missing)" >> "$OUT"

bq --project_id="$PROJECT" show --format=json "$PROJECT:$DATASET" >/tmp/dataset.json 2>/tmp/dataset.err
ds_rc=$?
if [ "$ds_rc" -ne 0 ]; then
  echo 'status=NOT_READY' >> "$OUT"
  echo 'reason=dataset_missing_or_unreadable' >> "$OUT"
  head -c 400 /tmp/dataset.err | tr '\n' ' ' | sed 's/^/detail=/' >> "$OUT"
  echo >> "$OUT"
  exit 0
fi

bq --project_id="$PROJECT" query --use_legacy_sql=false --format=csv --quiet "SELECT table_name FROM \`${PROJECT}.${DATASET}.INFORMATION_SCHEMA.TABLES\` ORDER BY table_name" >/tmp/tables.csv 2>/tmp/list.err
list_rc=$?
if [ "$list_rc" -ne 0 ]; then
  echo 'status=NOT_READY' >> "$OUT"
  echo 'reason=dataset_present_but_table_listing_failed' >> "$OUT"
  head -c 400 /tmp/list.err | tr '\n' ' ' | sed 's/^/detail=/' >> "$OUT"
  echo >> "$OUT"
  exit 0
fi

tail -n +2 /tmp/tables.csv | tr -d '"' >/tmp/table_names.txt
echo "tables=$(paste -sd, /tmp/table_names.txt)" >> "$OUT"
present=0
for t in ExportLog searchdata_url_impression searchdata_site_impression; do
  if grep -Fxq "$t" /tmp/table_names.txt; then
    echo "$t=present" >> "$OUT"
    present=$((present+1))
  else
    echo "$t=missing" >> "$OUT"
  fi
done
if [ "$present" -lt 3 ]; then
  echo 'status=NOT_READY' >> "$OUT"
  echo 'reason=expected_tables_missing' >> "$OUT"
  exit 0
fi

bq --project_id="$PROJECT" query --use_legacy_sql=false --format=csv --quiet "SELECT 'ExportLog' table_name, COUNT(*) row_count FROM \`${PROJECT}.${DATASET}.ExportLog\` UNION ALL SELECT 'searchdata_url_impression', COUNT(*) FROM \`${PROJECT}.${DATASET}.searchdata_url_impression\` UNION ALL SELECT 'searchdata_site_impression', COUNT(*) FROM \`${PROJECT}.${DATASET}.searchdata_site_impression\`" >/tmp/counts.csv 2>/tmp/query.err
q_rc=$?
if [ "$q_rc" -ne 0 ]; then
  echo 'status=NOT_READY' >> "$OUT"
  echo 'reason=tables_present_but_query_failed' >> "$OUT"
  head -c 400 /tmp/query.err | tr '\n' ' ' | sed 's/^/detail=/' >> "$OUT"
  echo >> "$OUT"
  exit 0
fi
cat /tmp/counts.csv >> "$OUT"
url_rows=$(awk -F, '$1 ~ /searchdata_url_impression/{gsub(/"/,"",$2); print $2}' /tmp/counts.csv)
site_rows=$(awk -F, '$1 ~ /searchdata_site_impression/{gsub(/"/,"",$2); print $2}' /tmp/counts.csv)
log_rows=$(awk -F, '$1 ~ /ExportLog/{gsub(/"/,"",$2); print $2}' /tmp/counts.csv)
if [ "${url_rows:-0}" -gt 0 ] && [ "${site_rows:-0}" -gt 0 ] && [ "${log_rows:-0}" -gt 0 ]; then
  echo 'status=READY' >> "$OUT"
  echo 'reason=export_tables_present_and_populated' >> "$OUT"
else
  echo 'status=NOT_READY' >> "$OUT"
  echo 'reason=tables_present_but_not_yet_populated' >> "$OUT"
fi
