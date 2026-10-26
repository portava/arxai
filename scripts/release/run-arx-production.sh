#!/usr/bin/env bash
# Initial production launch: use this repository’s built ARX application, with LIVE off.
set -euo pipefail
launch_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Shared legacy credentials and account bootstraps are not part of this launch.
# User-owned broker connections remain governed by ARX's normal database gates.
unset MT5_BRIDGE_TOKEN DERIV_API_TOKEN DERIV_APP_ID DERIV_ACCOUNT_ID DERIV_API_MODE DERIV_ENABLED DERIV_WS_URL
unset MT5_ENVIRONMENT BROKER_PROVIDER LIVE_TRADING_ALLOWED ARX_DERIV_OWNER_USER_ID ARX_EXECUTION_TIER
unset ARX_ADMIN_EMAIL ARX_ADMIN_INITIAL_PASSWORD ARX_OWNER_EMAIL ARX_LEGACY_OWNER_DEMOTE_EMAIL
unset OWNER_RESET_PASSWORD NEW_ADMIN_PASSWORD QA_OWNER_PASSWORD ARX_AUTH_TEST_PASSWORD VAULT_OVERRIDE_TOKEN
export NODE_ENV=production
export ALLOW_DEV_AUTH=false
export ARX_LIVE_BROKER_EXECUTION_ENABLED=false
export ARX_BETA_INVITE_REQUIRED=true
export PORT="${PORT:-8080}"
export APP_PUBLIC_ORIGIN="${APP_PUBLIC_ORIGIN:-${APP_BASE_URL:-}}"

if [[ "$#" -gt 1 || ( "$#" -eq 1 && "$1" != '--check' ) ]]; then
  printf '%s\n' 'Usage: run-arx-production.sh [--check]' >&2
  exit 2
fi
node "$launch_root/scripts/release/check-arx-production-env.mjs"
if [[ "${1:-}" == '--check' ]]; then exit 0; fi
cd "$launch_root"
test -f artifacts/api-server/dist/index.mjs || { printf '%s\n' 'Build the ARX API before starting production.' >&2; exit 2; }
exec node --enable-source-maps artifacts/api-server/dist/index.mjs
