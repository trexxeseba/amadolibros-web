#!/usr/bin/env bash
# Guarda la salida de un reporte en el bucket privado de R2, en vez de subirla
# como artefacto de GitHub Actions. En un repo público cualquiera con cuenta de
# GitHub puede bajar los artefactos; un bucket de R2 sin acceso público, no.
#
# Uso: scripts/ops/upload-report-r2.sh <carpeta> <nombre-del-reporte>
#   → amadolibros-reports/reports/<nombre>/<AAAA-MM-DD>/<run_id>/<archivo>
#
# Variables: CLOUDFLARE_API_TOKEN y CLOUDFLARE_ACCOUNT_ID (las de los deploys).
# REPORTS_BUCKET cambia el bucket (por defecto amadolibros-reports).
#
# Este script nunca imprime el contenido de los archivos: sólo nombres y
# tamaños. Los logs de Actions de un repo público también son públicos.
set -euo pipefail

SOURCE_DIR="${1:?falta la carpeta del reporte}"
REPORT_NAME="${2:?falta el nombre del reporte}"
BUCKET="${REPORTS_BUCKET:-amadolibros-reports}"
WRANGLER_VERSION="${WRANGLER_VERSION:-4.107.0}"
DAY="$(date -u +%Y-%m-%d)"
RUN="${GITHUB_RUN_ID:-local}"

if [[ ! "$REPORT_NAME" =~ ^[a-z0-9][a-z0-9-]{0,80}$ ]]; then
  echo "Nombre de reporte inválido: $REPORT_NAME" >&2
  exit 2
fi
if [[ ! -d "$SOURCE_DIR" ]]; then
  echo "No existe la carpeta $SOURCE_DIR" >&2
  exit 2
fi
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
  echo "Faltan CLOUDFLARE_API_TOKEN o CLOUDFLARE_ACCOUNT_ID" >&2
  exit 2
fi

wrangler() { npx --yes "wrangler@$WRANGLER_VERSION" "$@"; }

# El bucket se crea la primera vez. R2 lo crea privado: sin dominio público ni
# r2.dev, sólo se lee con credenciales de la cuenta.
if ! wrangler r2 bucket info "$BUCKET" >/dev/null 2>&1; then
  wrangler r2 bucket create "$BUCKET" >/dev/null
fi

content_type() {
  case "$1" in
    *.json) echo 'application/json' ;;
    *.csv) echo 'text/csv; charset=utf-8' ;;
    *.md) echo 'text/markdown; charset=utf-8' ;;
    *.html) echo 'text/html; charset=utf-8' ;;
    *.txt|*.log) echo 'text/plain; charset=utf-8' ;;
    *.png) echo 'image/png' ;;
    *.jpg|*.jpeg) echo 'image/jpeg' ;;
    *) echo 'application/octet-stream' ;;
  esac
}

count=0
while IFS= read -r -d '' file; do
  relative="${file#"$SOURCE_DIR"/}"
  key="reports/$REPORT_NAME/$DAY/$RUN/$relative"
  wrangler r2 object put "$BUCKET/$key" --remote --file "$file" \
    --content-type "$(content_type "$file")" >/dev/null
  count=$((count + 1))
done < <(find "$SOURCE_DIR" -type f -print0)

if [[ "$count" -eq 0 ]]; then
  echo "La carpeta $SOURCE_DIR está vacía: no se subió nada." >&2
  exit 1
fi

echo "Guardados $count archivos en R2: $BUCKET/reports/$REPORT_NAME/$DAY/$RUN/"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo "- Reporte guardado en R2 (privado): \`$BUCKET/reports/$REPORT_NAME/$DAY/$RUN/\` ($count archivos)" >> "$GITHUB_STEP_SUMMARY"
fi
