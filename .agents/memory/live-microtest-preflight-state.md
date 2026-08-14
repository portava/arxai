---
name: Live micro-test preflight depends on operator-side runtime state
description: Before any real live-trade verification, check EA heartbeat freshness + master pool funding first — these are operator states the agent cannot fix.
---

A real live micro-test in the live environment is gated on runtime state that the
agent **cannot change from inside the environment**. Check these FIRST (read-only)
before attempting any live dispatch or spending effort on auth/diagnostic gymnastics:

1. **EA heartbeat freshness** — `select now(), last_heartbeat, age from mt5_connection
   order by last_heartbeat desc`. If `last_heartbeat` is **frozen** (timestamp does not
   advance across repeated reads while `now()` does), the remote EA/MT5 terminal is
   **offline**. Gate #7 (heartbeat ≤15s) hard-fails → `MASTER_BRIDGE_HEARTBEAT_STALE`.
   The EA runs on the operator's machine/VPS — it cannot be started from here.
2. **Master pool funding** — `select mt5_balance, total_allocated, is_over_allocated from
   arx_master_bridge_pool`. An unfunded live account (e.g. balance $2.44 vs $1006
   allocated, `is_over_allocated=TRUE`) blocks every entry order with
   `POOL_OVER_ALLOCATED` / `USER_ALLOCATION_EXHAUSTED`, independent of the heartbeat.
3. **Phantom open positions** — `arx_live_positions` rows with `closed_at IS NULL` that
   contradict the broker snapshot (broker balance/equity small, used_margin 0 ⇒ broker has
   no open positions) are stale/phantom. Do NOT reconcile them in a verification task — the
   reconciler stays dry-run by design; note them as an operator action.

**Why:** a Bridge v2 live micro-test was correctly BLOCKED at the decision point:
EA offline + unfunded account. The honest outcome is STOP + exact-blocker report, never a
faked fill. Don't restart workflows hoping the EA reconnects — it's remote.

**Authoritative flags live under `mt5_connection.capabilities.eaInputs`**, not the flat
`read_only_mode`/`allow_order_execution` columns (which can read false/misleading on v1.50).
See ea-heartbeat-eainputs-shape.md.
