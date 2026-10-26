#!/usr/bin/env bash
# Build and smoke-test the production ARX web bundle and separately routed API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB_MANIFEST="$ROOT/artifacts/trading-dashboard/.replit-artifact/artifact.toml"
API_MANIFEST="$ROOT/artifacts/api-server/.replit-artifact/artifact.toml"
WEB_ARTIFACT="$ROOT/arxai/artifacts/trading-dashboard"
API_BUNDLE="$ROOT/artifacts/api-server/dist/index.mjs"

fail() {
  printf 'ARX production smoke check failed: %s\n' "$*" >&2
  exit 1
}

[[ -f "$WEB_MANIFEST" ]] || fail "dashboard production manifest is missing"
[[ -f "$API_MANIFEST" ]] || fail "API production manifest is missing"
grep -Fxq 'serve = "static"' "$WEB_MANIFEST" ||
  fail "dashboard production service must serve its built static bundle"
grep -Fxq 'publicDir = "arxai/artifacts/trading-dashboard/dist/public"' "$WEB_MANIFEST" ||
  fail "dashboard production service points to the wrong build directory"
grep -Fxq 'from = "/*"' "$WEB_MANIFEST" ||
  fail "dashboard production history fallback is missing"
grep -Fxq 'to = "/index.html"' "$WEB_MANIFEST" ||
  fail "dashboard production history fallback must serve index.html"
grep -Fq 'paths = ["/api"]' "$API_MANIFEST" ||
  fail "API production service must remain separately routed under /api"
grep -Fq 'path = "/api/healthz"' "$API_MANIFEST" ||
  fail "API production health check must remain at /api/healthz"

cd "$ROOT"
PORT=24210 BASE_PATH=/ NODE_ENV=production \
  pnpm --dir arxai --filter @workspace/trading-dashboard run build
NODE_ENV=production pnpm --filter @workspace/api-server run build

[[ -s "$WEB_ARTIFACT/dist/public/index.html" ]] ||
  fail "production dashboard build did not produce index.html"
[[ -s "$API_BUNDLE" ]] ||
  fail "production API build did not produce its server bundle"

free_port() {
  node --input-type=module -e '
    import net from "node:net";
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      console.log(server.address().port);
      server.close();
    });
  '
}

WEB_PORT="$(free_port)"
API_PORT="$(free_port)"
TMP_DIR="$(mktemp -d)"
WEB_PID=""
API_PID=""
cleanup() {
  [[ -z "$WEB_PID" ]] || kill "$WEB_PID" 2>/dev/null || true
  [[ -z "$API_PID" ]] || kill "$API_PID" 2>/dev/null || true
  [[ -z "$WEB_PID" ]] || wait "$WEB_PID" 2>/dev/null || true
  [[ -z "$API_PID" ]] || wait "$API_PID" 2>/dev/null || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PORT="$WEB_PORT" BASE_PATH=/ NODE_ENV=production \
  pnpm --dir arxai --filter @workspace/trading-dashboard run serve \
  >"$TMP_DIR/web.log" 2>&1 &
WEB_PID=$!
PORT="$API_PORT" NODE_ENV=production \
  node --enable-source-maps "$API_BUNDLE" >"$TMP_DIR/api.log" 2>&1 &
API_PID=$!

wait_for_http() {
  local url="$1"
  local name="$2"
  local attempts
  for attempts in {1..60}; do
    if curl --silent --fail --output "$TMP_DIR/$name.body" \
      --dump-header "$TMP_DIR/$name.headers" "$url"; then
      return 0
    fi
    if ! kill -0 "$WEB_PID" 2>/dev/null && ! kill -0 "$API_PID" 2>/dev/null; then
      fail "production services exited before becoming ready"
    fi
    sleep 1
  done
  fail "timed out waiting for $url"
}

fetch_200() {
  local url="$1"
  local name="$2"
  local code
  code="$(curl --silent --show-error --location --connect-timeout 2 --max-time 10 \
    --output "$TMP_DIR/$name.body" --dump-header "$TMP_DIR/$name.headers" \
    --write-out '%{http_code}' "$url")" ||
    fail "could not fetch $url"
  [[ "$code" == "200" ]] || fail "$url returned HTTP $code"
}

fetch_missing_asset() {
  local url="$1"
  local name="$2"
  local code
  code="$(curl --silent --show-error --location --connect-timeout 2 --max-time 10 \
    --output "$TMP_DIR/$name.body" --dump-header "$TMP_DIR/$name.headers" \
    --write-out '%{http_code}' "$url")" ||
    fail "could not fetch $url"
  [[ "$code" == "404" ]] || fail "$url returned HTTP $code instead of 404"
  if grep -Eiq '^content-type:.*(javascript|ecmascript|text/css)' "$TMP_DIR/$name.headers"; then
    fail "$url returned an asset content type for a missing file"
  fi
  if grep -Fq '<title>ARX AI' "$TMP_DIR/$name.body"; then
    fail "$url returned the dashboard HTML fallback instead of a missing-file response"
  fi
}

WEB_URL="http://127.0.0.1:$WEB_PORT"
API_URL="http://127.0.0.1:$API_PORT"
wait_for_http "$WEB_URL/" "web-ready"
wait_for_http "$API_URL/api/healthz" "api-ready"

for route in / /login; do
  name="page-$(printf '%s' "$route" | tr '/' '_')"
  fetch_200 "$WEB_URL$route" "$name"
  grep -Eiq '^content-type:.*text/html' "$TMP_DIR/$name.headers" ||
    fail "$route did not return HTML"
  grep -Fq '<title>ARX AI' "$TMP_DIR/$name.body" ||
    fail "$route did not return the ARX HTML document"
done

ENTRY_ASSET="$(grep -Eo 'src="/assets/[^"]+\.js"' "$TMP_DIR/page-_.body" | head -1 | cut -d '"' -f 2 || true)"
[[ -n "$ENTRY_ASSET" ]] || fail "built HTML does not reference a JavaScript entry asset"
fetch_200 "$WEB_URL$ENTRY_ASSET" "entry-asset"
grep -Eiq '^content-type:.*(javascript|ecmascript)' "$TMP_DIR/entry-asset.headers" ||
  fail "built frontend entry asset did not return JavaScript"
[[ -s "$TMP_DIR/entry-asset.body" ]] || fail "built frontend entry asset was empty"

if ! node --input-type=module - "$TMP_DIR/entry-asset.body" "$ENTRY_ASSET" \
  >"$TMP_DIR/chunk-assets.txt" <<'NODE'
import fs from "node:fs";

const [bundlePath, entryAsset] = process.argv.slice(2);
const bundle = fs.readFileSync(bundlePath, "utf8");
const chunkAssets = new Set();
for (const match of bundle.matchAll(/\bimport\s*\(\s*["']([^"']+\.js(?:\?[^"']*)?)["']\s*\)/g)) {
  const specifier = match[1];
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) continue;
  const assetPath = new URL(specifier, `http://arx.local${entryAsset}`).pathname;
  if (assetPath.startsWith("/assets/") && assetPath.endsWith(".js")) {
    chunkAssets.add(assetPath);
  }
}

if (chunkAssets.size === 0) {
  console.error("built frontend entry asset did not reference any local JavaScript chunks");
  process.exit(1);
}
for (const assetPath of chunkAssets) console.log(assetPath);
NODE
then
  fail "could not discover JavaScript chunks referenced by the built entry asset"
fi

chunk_number=0
while IFS= read -r CHUNK_ASSET; do
  ((chunk_number += 1))
  chunk_name="chunk-$chunk_number"
  fetch_200 "$WEB_URL$CHUNK_ASSET" "$chunk_name"
  grep -Eiq '^content-type:.*(javascript|ecmascript)' "$TMP_DIR/$chunk_name.headers" ||
    fail "$CHUNK_ASSET did not return JavaScript"
  [[ -s "$TMP_DIR/$chunk_name.body" ]] ||
    fail "$CHUNK_ASSET returned an empty JavaScript chunk"
done <"$TMP_DIR/chunk-assets.txt"

CSS_ASSET="$(grep -Eo 'href="/assets/[^"]+\.css"' "$TMP_DIR/page-_.body" | head -1 | cut -d '"' -f 2 || true)"
if [[ -n "$CSS_ASSET" ]]; then
  fetch_200 "$WEB_URL$CSS_ASSET" "style-asset"
  grep -Eiq '^content-type:.*text/css' "$TMP_DIR/style-asset.headers" ||
    fail "built stylesheet did not return CSS"
  [[ -s "$TMP_DIR/style-asset.body" ]] || fail "built stylesheet asset was empty"
fi

fetch_missing_asset "$WEB_URL/assets/__arx_missing_asset__.js" "missing-js-asset"
fetch_missing_asset "$WEB_URL/assets/__arx_missing_asset__.css" "missing-css-asset"

fetch_200 "$API_URL/api/healthz" "healthz"
grep -Eiq '^content-type:.*application/json' "$TMP_DIR/healthz.headers" ||
  fail "/api/healthz did not return JSON"
grep -Eq '"app"[[:space:]]*:[[:space:]]*"ARX AI"' "$TMP_DIR/healthz.body" ||
  fail "/api/healthz did not identify ARX AI"
grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' "$TMP_DIR/healthz.body" ||
  fail "/api/healthz did not report a healthy service"

printf 'ARX production smoke check passed: /, /login, built/missing assets (%s lazy chunks), separate /api/healthz\n' "$chunk_number"
