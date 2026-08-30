#!/usr/bin/env bash
# ARX capability #28 — start the independent protection watchdog.
#
# This is the ONE command for every topology. What changes between topology
# (a) same host, (b) a second Replit instance and (c) an external host is the
# ENVIRONMENT and the box it runs on — not the command.
#
#   ./scripts/watchdog/start-watchdog.sh
#
# It refuses to start silently misconfigured. A watchdog that runs but cannot
# reach anybody is worse than no watchdog, because the dashboard looks covered.
#
# It NEVER creates a credential. Every secret below is set by the owner.
# See docs/WATCHDOG_DEPLOYMENT.md for the owner-press list.

set -euo pipefail

RED=$'\033[31m'; YEL=$'\033[33m'; GRN=$'\033[32m'; OFF=$'\033[0m'
fail() { echo "${RED}REFUSING TO START:${OFF} $1" >&2; exit 2; }
warn() { echo "${YEL}DEGRADED:${OFF} $1" >&2; }
ok()   { echo "${GRN}ok:${OFF} $1" >&2; }

# ── 1. It must be able to SEE ────────────────────────────────────────────────
DB="${ARX_WATCHDOG_DATABASE_URL:-${DATABASE_URL:-}}"
[ -n "$DB" ] || fail "neither ARX_WATCHDOG_DATABASE_URL nor DATABASE_URL is set — the watchdog cannot read protection state."
if [ -n "${ARX_WATCHDOG_DATABASE_URL:-}" ]; then
  ok "using ARX_WATCHDOG_DATABASE_URL (set this to the read-only role for topologies b/c)"
else
  warn "falling back to DATABASE_URL. The session is still forced read-only, but prefer a dedicated read-only role off-host."
fi

# ── 2. It must be able to TELL SOMEBODY ──────────────────────────────────────
ARMED=1
[ -n "${ARX_WATCHDOG_ALERT_INGEST_URL:-}" ] || { warn "ARX_WATCHDOG_ALERT_INGEST_URL is unset — findings will NOT reach the in-app notification service."; ARMED=0; }
[ -n "${ARX_WATCHDOG_INGEST_TOKEN:-}"     ] || { warn "ARX_WATCHDOG_INGEST_TOKEN is unset — the app leg of the alert path is disarmed."; ARMED=0; }
if [ -n "${ARX_WATCHDOG_INGEST_TOKEN:-}" ] && [ "${#ARX_WATCHDOG_INGEST_TOKEN}" -lt 16 ]; then
  fail "ARX_WATCHDOG_INGEST_TOKEN is shorter than 16 characters; the server rejects it. Choose a longer value."
fi
[ -n "${ARX_WATCHDOG_WEBHOOK_URL:-}" ] || warn "ARX_WATCHDOG_WEBHOOK_URL is unset — if the app itself is down there is no independent channel to the owner."
if [ "$ARMED" = "1" ]; then ok "alert path armed: app notification service + $( [ -n "${ARX_WATCHDOG_WEBHOOK_URL:-}" ] && echo "operator webhook" || echo "no independent webhook" )"; fi
if [ "$ARMED" = "0" ] && [ "${ARX_WATCHDOG_ALLOW_UNARMED:-}" != "1" ]; then
  fail "the alert path is not armed. Arm it, or set ARX_WATCHDOG_ALLOW_UNARMED=1 to run logs-only ON PURPOSE."
fi

# ── 3. It must say which failure domain it actually covers ───────────────────
case "${ARX_WATCHDOG_TOPOLOGY:-}" in
  same_host)     warn "topology=same_host — this DIES WITH THE BOX. It detects a dead/wedged api-server; it does not survive a host outage." ;;
  second_repl)   ok   "topology=second_repl — survives the app Repl dying; does not survive a Replit-wide or DB outage." ;;
  external_host) ok   "topology=external_host — survives the app host entirely; does not survive a DB outage (it alerts CANNOT_VERIFY)." ;;
  *)             warn "ARX_WATCHDOG_TOPOLOGY unset — set same_host | second_repl | external_host so the heartbeat records what this instance really covers." ;;
esac

echo "${GRN}starting${OFF} interval=${ARX_WATCHDOG_INTERVAL_MS:-60000}ms health=:${ARX_WATCHDOG_HEALTH_PORT:-8091}/healthz instance=${ARX_WATCHDOG_INSTANCE_ID:-<host:pid>}" >&2

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT/artifacts/api-server"
exec node --enable-source-maps --import tsx src/watchdog.ts "$@"
