#!/usr/bin/env bash
# Development-only adapter. Original ARX application source stays in arxai/.
set -eu
cd "$(dirname "$0")/../arxai"

# Never connect imported broker credentials or bootstrap privileged accounts
# while validating the baseline. No secret values are read or printed here.
unset DERIV_API_TOKEN DERIV_APP_ID DERIV_ACCOUNT_ID DERIV_API_MODE DERIV_ENABLED DERIV_WS_URL
unset MT5_BRIDGE_TOKEN MT5_ENVIRONMENT BROKER_PROVIDER LIVE_TRADING_ALLOWED ARX_DERIV_OWNER_USER_ID ARX_EXECUTION_TIER
unset ARX_ADMIN_EMAIL ARX_ADMIN_INITIAL_PASSWORD ARX_OWNER_EMAIL OWNER_RESET_PASSWORD NEW_ADMIN_PASSWORD QA_OWNER_PASSWORD
unset VAULT_OVERRIDE_TOKEN
export ARX_LIVE_BROKER_EXECUTION_ENABLED=false
exec pnpm --filter @workspace/api-server run dev
