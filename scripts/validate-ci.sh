#!/usr/bin/env bash
#
# scripts/validate-ci.sh — validador único de CI y pre-deploy.
#
# Este script es la única fuente de verdad de lo que significa "el checkout
# está bien" antes de dejar avanzar un build hacia Producción. Lo invocan dos
# workflows distintos (.github/workflows/ci.yml en cada PR, y el job
# `validate` de .github/workflows/deploy.yml antes de cada deploy a main) —
# si algún día divergieran (uno revisando checkout ON y otro no, o con site
# keys distintas), un PR podría pasar CI en verde y romper igual el deploy.
# Correr exactamente el mismo script en los dos lugares es lo que evita esa
# divergencia: cualquier cambio a la validación se edita acá una sola vez.
#
# Modos:
#   scripts/validate-ci.sh                      → corre toda la validación.
#   scripts/validate-ci.sh --print-turnstile-config
#       → imprime en formato GITHUB_OUTPUT (site_key=..., allowed_hosts=...)
#         los valores públicos de Turnstile de Producción, sin correr nada
#         más. Lo usa el job `deploy` para construir el build real que se
#         despliega con los MISMOS valores que este script ya validó — nunca
#         un segundo literal copiado a mano en el YAML que pueda desviarse.
#
# No toca D1, no llama a Mercado Pago, no llama al servicio real de
# Turnstile — los tokens de Turnstile en los tests son siempre mocks.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── Configuración pública de Turnstile — única fuente de verdad ─────────────
# La site key no es secreta (viaja en el HTML); el secret vive solo en
# Cloudflare Pages y nunca se declara acá.
readonly PRODUCTION_TURNSTILE_SITE_KEY='0x4AAAAAAD_Ul8KGae_hdWwj'
readonly PRODUCTION_TURNSTILE_ALLOWED_HOSTS='amadolibros.com,www.amadolibros.com'
readonly PREVIEW_TURNSTILE_SITE_KEY='0x4AAAAAAD6E9kz8K3comwjj'

if [[ "${1:-}" == "--print-turnstile-config" ]]; then
  echo "site_key=${PRODUCTION_TURNSTILE_SITE_KEY}"
  echo "allowed_hosts=${PRODUCTION_TURNSTILE_ALLOWED_HOSTS}"
  exit 0
fi

step() { printf '\n[validate-ci] ── %s ──────────────────────────\n' "$1"; }

# Detecta un elemento HTML realmente renderizado con ese id — igual que
# hasRenderedElementWithId() en scripts/smoke-production.js. No alcanza con
# que el id aparezca en cualquier parte del documento: el bloque <script> de
# carrito.astro tiene referencias inertes como
# document.getElementById('cf-ts-container') incluso con el checkout
# apagado, cuando el elemento nunca se renderiza.
has_rendered_element_with_id() {
  local file="$1" id="$2"
  grep -Eq "<[a-zA-Z][a-zA-Z0-9-]*[[:space:]][^>]*id=[\"']${id}[\"']" "$file"
}

# Cloudflare Pages deja de aplicar el fallback SPA cuando el artefacto incluye
# 404.html. Este guard evita volver a publicar la portada con HTTP 200 para
# rutas inexistentes y exige que la página de error nunca sea indexable.
assert_404_page() {
  local file='astro-front/dist/404.html'
  test -f "$file"
  grep -Eq '<meta name="robots" content="noindex, nofollow">' "$file"
  grep -Eq '<h1[^>]*id="not-found-title"' "$file"
  grep -Eq '<a[^>]*href="/catalogo"' "$file"
  grep -Eq '<a[^>]*href="/"' "$file"
  ! grep -Eq '<link rel="canonical"' "$file"
  echo "  OK: 404.html presente, no indexable y con salidas útiles."
}

# ── 1. Sintaxis ───────────────────────────────────────────────────────────
step "Sintaxis JS/MJS (functions, scripts, worker-sync)"
find functions scripts worker-sync -type f \( -name '*.js' -o -name '*.mjs' \) -print0 |
  xargs -0 -r -n1 node --check

# ── 2. Suite completa ─────────────────────────────────────────────────────
step "Suite completa de tests"
node --test worker-sync/__tests__/*.test.js
# Node 22.12 (runner fijado en CI/deploy) todavía mantiene node:sqlite detrás
# de este flag. En Node >=22.13 el flag es inocuo y conserva la misma suite.
node --experimental-sqlite --test functions/__tests__/*.test.js
node --test astro-front/src/lib/__tests__/*.test.js
node --test functions/api/__tests__/*.test.js

# ── 3. Dependencias de Astro ──────────────────────────────────────────────
step "Instalar dependencias de astro-front"
(cd astro-front && npm ci --no-audit --no-fund)

# ── 4. Build con checkout OFF ─────────────────────────────────────────────
step "Build — checkout OFF"
(
  cd astro-front
  rm -rf dist
  PUBLIC_INDEXABLE=true \
  PUBLIC_GA_ID=G-SDX45VEPP3 \
  PUBLIC_CHECKOUT_ENABLED=false \
  PUBLIC_TURNSTILE_SITE_KEY="$PRODUCTION_TURNSTILE_SITE_KEY" \
  PUBLIC_TURNSTILE_ALLOWED_HOSTS="$PRODUCTION_TURNSTILE_ALLOWED_HOSTS" \
  npm run build
)

assert_404_page

CART_OFF=astro-front/dist/carrito/index.html
test -f "$CART_OFF"
grep -q 'data-online-checkout="disabled"' "$CART_OFF"
! has_rendered_element_with_id "$CART_OFF" 'btn-prepare-order'
! has_rendered_element_with_id "$CART_OFF" 'btn-transfer-order'
! has_rendered_element_with_id "$CART_OFF" 'transfer-payment-step'
! has_rendered_element_with_id "$CART_OFF" 'btn-pay-mp'
! has_rendered_element_with_id "$CART_OFF" 'cf-ts-container'
has_rendered_element_with_id "$CART_OFF" 'btn-wa-order'
echo "  OK: checkout apagado — sin controles de pago, WhatsApp presente."

rm -rf astro-front/dist

# ── 5. Build con checkout ON ──────────────────────────────────────────────
step "Build — checkout ON (config pública de Turnstile igual a Producción)"
(
  cd astro-front
  rm -rf dist
  PUBLIC_INDEXABLE=true \
  PUBLIC_GA_ID=G-SDX45VEPP3 \
  PUBLIC_CHECKOUT_ENABLED=true \
  PUBLIC_TURNSTILE_SITE_KEY="$PRODUCTION_TURNSTILE_SITE_KEY" \
  PUBLIC_TURNSTILE_ALLOWED_HOSTS="$PRODUCTION_TURNSTILE_ALLOWED_HOSTS" \
  npm run build
)

assert_404_page

CART_ON=astro-front/dist/carrito/index.html
test -f "$CART_ON"
grep -q 'data-online-checkout="enabled"' "$CART_ON"
has_rendered_element_with_id "$CART_ON" 'btn-prepare-order'
has_rendered_element_with_id "$CART_ON" 'btn-transfer-order'
has_rendered_element_with_id "$CART_ON" 'transfer-payment-step'
has_rendered_element_with_id "$CART_ON" 'cf-ts-container'
has_rendered_element_with_id "$CART_ON" 'btn-wa-order'
grep -q "$PRODUCTION_TURNSTILE_SITE_KEY" "$CART_ON"
! grep -q "$PREVIEW_TURNSTILE_SITE_KEY" "$CART_ON"
echo "  OK: checkout encendido — controles y Turnstile de Producción presentes, Preview ausente."

rm -rf astro-front/dist

step "Validación completa OK"
