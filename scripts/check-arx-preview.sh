#!/usr/bin/env bash
# Read-only smoke check of ARX through Replit's shared preview router.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ADAPTER="$ROOT/artifacts/trading-dashboard/.replit-artifact/artifact.toml"

fail() {
  printf 'ARX preview smoke check failed: %s\n' "$*" >&2
  exit 1
}

[[ -f "$ADAPTER" ]] || fail "dashboard artifact registration is missing: $ADAPTER"

# The imported nested source must not register a second dashboard artifact.
mapfile -d '' -t dashboard_manifests < <(
  find "$ROOT/artifacts" "$ROOT/arxai/artifacts" \
    -type d -name node_modules -prune -o \
    -type f -path '*/.replit-artifact/artifact.toml' -print0 |
    while IFS= read -r -d '' manifest; do
      if grep -Fxq 'id = "artifacts/trading-dashboard"' "$manifest" ||
        grep -Fxq 'title = "ARX AI"' "$manifest"; then
        printf '%s\0' "$manifest"
      fi
    done
)

[[ ${#dashboard_manifests[@]} -eq 1 ]] ||
  fail "expected exactly one ARX dashboard registration; found ${#dashboard_manifests[@]}"
[[ "${dashboard_manifests[0]}" == "$ADAPTER" ]] ||
  fail "ARX dashboard registration must be the top-level routing adapter"
grep -Fxq 'id = "artifacts/trading-dashboard"' "$ADAPTER" ||
  fail "adapter has the wrong artifact ID"
grep -Fxq 'previewPath = "/"' "$ADAPTER" ||
  fail "adapter preview path must remain /"
grep -Fxq 'run = "bash ../../scripts/run-arx-web.sh"' "$ADAPTER" ||
  fail "adapter must use the managed dashboard launcher"

DOMAIN="${REPLIT_DEV_DOMAIN:-}"
[[ -n "$DOMAIN" ]] || fail "REPLIT_DEV_DOMAIN is required; check the shared router, not a direct Vite port"
[[ "$DOMAIN" != *"://"* && "$DOMAIN" != */* && "$DOMAIN" != *:* ]] ||
  fail "REPLIT_DEV_DOMAIN must be a host name without a scheme or path"
[[ "$DOMAIN" != *localhost* && "$DOMAIN" != *127.0.0.1* ]] ||
  fail "direct or local service URLs are not allowed; use the shared preview router"
BASE_URL="https://$DOMAIN"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

fetch() {
  local route="$1"
  local name="$2"
  local code
  code="$(curl --silent --show-error --location --connect-timeout 5 --max-time 15 \
    --output "$TMP_DIR/$name.body" --dump-header "$TMP_DIR/$name.headers" \
    --write-out '%{http_code}' "$BASE_URL$route")" ||
    fail "could not fetch $route through the shared router"
  [[ "$code" == "200" ]] || fail "$route returned HTTP $code through the shared router"
}

for route in / /login; do
  name="page-$(printf '%s' "$route" | tr '/' '_')"
  fetch "$route" "$name"
  grep -Eiq '^content-type:.*text/html' "$TMP_DIR/$name.headers" ||
    fail "$route did not return HTML"
  grep -Fq '<title>ARX AI' "$TMP_DIR/$name.body" ||
    fail "$route did not return the ARX HTML document"
  grep -Fq '/src/main.tsx' "$TMP_DIR/$name.body" ||
    fail "$route did not include the dashboard entry module"
done

fetch "/src/main.tsx" "frontend-module"
grep -Eiq '^content-type:.*(javascript|ecmascript)' "$TMP_DIR/frontend-module.headers" ||
  fail "/src/main.tsx did not return a JavaScript module"
[[ -s "$TMP_DIR/frontend-module.body" ]] ||
  fail "/src/main.tsx returned an empty module"

fetch "/api/healthz" "healthz"
grep -Eiq '^content-type:.*application/json' "$TMP_DIR/healthz.headers" ||
  fail "/api/healthz did not return JSON"
grep -Eq '"app"[[:space:]]*:[[:space:]]*"ARX AI"' "$TMP_DIR/healthz.body" ||
  fail "/api/healthz did not identify ARX AI"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$TMP_DIR/healthz.body" ||
  fail "/api/healthz did not report a healthy service"

printf 'ARX shared-preview smoke check passed: /, /login, /src/main.tsx, /api/healthz\n'
