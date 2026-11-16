#!/usr/bin/env bash
# App-specific initial nontrading deployment. No secrets are set here.
set -euo pipefail
release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export APP_BASE_URL=https://arx-ai-baseline-import.replit.app
export APP_PUBLIC_ORIGIN="$APP_BASE_URL"
exec bash "$release_root/arxai/scripts/release/run-arx-production.sh" "$@"
