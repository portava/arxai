#!/usr/bin/env bash
# Development-only adapter. Original ARX application source stays in arxai/.
set -eu
cd "$(dirname "$0")/../arxai"

# Keep imported broker credentials and legacy owner/reset access disabled.
# The operator-approved preview admin bootstrap receives ARX_ADMIN_EMAIL and
# ARX_ADMIN_INITIAL_PASSWORD; existing passwords are never overwritten.
# No secret values are read or printed by this launcher.
unset DERIV_API_TOKEN DERIV_APP_ID DERIV_ACCOUNT_ID DERIV_API_MODE DERIV_ENABLED DERIV_WS_URL
unset MT5_BRIDGE_TOKEN MT5_ENVIRONMENT BROKER_PROVIDER LIVE_TRADING_ALLOWED ARX_DERIV_OWNER_USER_ID ARX_EXECUTION_TIER
unset ARX_OWNER_EMAIL ARX_OWNER_INITIAL_PASSWORD OWNER_RESET_PASSWORD NEW_ADMIN_PASSWORD QA_OWNER_PASSWORD ARX_AUTH_TEST_PASSWORD
unset VAULT_OVERRIDE_TOKEN
export ARX_LIVE_BROKER_EXECUTION_ENABLED=false
# Public prices only in development; account authorization and trading remain disabled.
export ARX_DERIV_PUBLIC_DATA_ENABLED=true
exec pnpm --filter @workspace/api-server run dev
