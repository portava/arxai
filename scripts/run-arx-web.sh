#!/usr/bin/env bash
# Keep the imported workspace intact while routing through a top-level artifact.
set -eu

if [ "${1:-}" = "--preview-smoke" ]; then
  shift
  exec bash "$(dirname "$0")/check-arx-preview.sh" "$@"
fi

cd "$(dirname "$0")/../arxai"
unset ARX_AUTH_TEST_PASSWORD
exec pnpm --filter @workspace/trading-dashboard run dev
