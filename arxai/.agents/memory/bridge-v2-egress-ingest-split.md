---
name: Bridge v2 egress/ingest read-asymmetry
description: Why the v2 EA command channel may READ execution tables while ingest may not, and how the CI guard enforces it per-file.
---

# Bridge v2 egress vs ingest — execution-table read asymmetry

The v2 bridge splits server↔EA traffic into two files with **opposite** rules
about touching execution tables (`arx_live_commands`, `arx_live_positions`,
`mt5_commands`, `mt5_demo_commands`):

- `artifacts/api-server/src/lib/bridgeV2/ingest.ts` (EA→server, telemetry):
  **must not reference any execution table at all** (read or write).
- `artifacts/api-server/src/lib/bridgeV2/egress.ts` (server→EA, command channel):
  **MAY READ `arx_live_commands`** to project rows already at status
  `SENT_TO_MT5_LIVE` (post-16-gate), but **must never INSERT/UPDATE/DELETE** any
  execution/position table and never import the live dispatch pipeline.

**Why:** the safety invariant is "ingest is never a second execution path." A
pure read-projection of already-dispatched rows is not an execution path, so
egress reading them is safe; ingest referencing them at all is the smell we
forbid. State-flip-on-poll and the COMMAND_RESULT write-back are deliberately
deferred out of egress to keep it read-only.

**How to apply:** the CI guard `scripts/src/ci/check-bridge-v2-truth.ts` scans
**by file**: forbidden execution-table *references* in `ingest.ts`; only
*mutation patterns* (`.insert(`/`.update(`/`.delete(` on those tables) + pipeline
imports in `egress.ts`. It also asserts both EA GETs (`/bridge/v2/config`,
`/bridge/v2/commands`) are registered with `bridgeAuthPerUserOnly` AND on the
globalGate PUBLIC_EXACT allowlist. If you add an egress read of another
execution table, expect the guard to stay green — but any write trips it.

Note: in `lifecycle.ts` `mapLifecycleForMessage`, `DEAL_HISTORY` is
lifecycle-bearing (→ `CLOSED`), NOT telemetry; only the other 9 non-result types
return null. Don't assume "history/snapshot ⇒ telemetry."
