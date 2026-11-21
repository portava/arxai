#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
pnpm install --frozen-lockfile
# Syncing application source must not apply an unreviewed schema diff to the
# database in the workspace environment. Migrations belong to the reviewed
# release workflow; the structural forecast feature requires none.
printf '%s\n' 'Dependencies installed. No database schema changes were applied.'
