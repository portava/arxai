#!/usr/bin/env bash
set -euo pipefail
launch_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NODE_ENV=production
case "${1:-}" in
  api) exec pnpm --dir "$launch_root" --filter @workspace/api-server run build ;;
  web)
    export PORT="${PORT:-24210}"
    export BASE_PATH=/
    exec pnpm --dir "$launch_root" --filter @workspace/trading-dashboard run build ;;
  *) printf '%s\n' 'Usage: build-arx-production.sh api|web' >&2; exit 2 ;;
esac
