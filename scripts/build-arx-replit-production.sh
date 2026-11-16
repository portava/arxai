#!/usr/bin/env bash
# Build the imported ARX workspace, not the root preview scaffold.
set -euo pipefail
release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pnpm --dir "$release_root/arxai" install --frozen-lockfile
bash "$release_root/arxai/scripts/release/build-arx-production.sh" api
bash "$release_root/arxai/scripts/release/build-arx-production.sh" web
