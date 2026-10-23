#!/usr/bin/env bash
# Keep the imported workspace intact while routing through a top-level artifact.
set -eu
cd "$(dirname "$0")/../arxai"
exec pnpm --filter @workspace/trading-dashboard run dev
