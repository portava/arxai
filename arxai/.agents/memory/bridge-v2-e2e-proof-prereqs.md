---
name: Bridge v2 end-to-end live-proof prerequisites
description: The real-state prerequisites that must hold before a Bridge v2 live micro-test proof can run, and why it must STOP rather than fake any step.
---

The Bridge v2 backend (ingest/config/commands + admin trace/status) is built,
wired, and fail-closed (all endpoints `401` unauth; healthz `200`). v1.50 keeps
writing `/api/mt5/*` → `mt5_connection`; the v2 EA POSTs to `/api/bridge/v2/ingest`
(same per-user `X-MT5-Bridge-Token`) → `bridge_v2_events` — separate tables, no
collision. The two EAs run on separate charts with distinct magic numbers.

The **end-to-end live proof depends on real operator state the agent cannot
create**, so it must STOP + report honestly — never fake a verification step or a
fill. Before attempting the proof, re-check ALL of:

- **Telemetry half:** v2 telemetry tables non-empty with a FRESH v2 EA heartbeat
  (HEARTBEAT/ACCOUNT/POSITIONS/ORDERS/CONFIG_ACK/SYMBOL_SPEC accepted, in-order,
  freshness LIVE). `TRADE_TRANSACTION`/`DEAL_HISTORY` only appear after a real
  micro-trade — their absence pre-trade is expected, not a failure.
- **Master pool funded + within cap:** `arx_master_bridge_pool.is_over_allocated
  = FALSE` with a FRESH snapshot, and the owner/test user actually has a positive
  `user_slot_allocation` (a full allocation wipe zeros the owner too, so the
  micro-test needs a small allocation re-added first unless owner
  allocation-bypass is active).
- **Position truth:** the test user's open `arx_live_positions` floating P/L must
  reconcile against real broker equity−balance. A large mismatch means
  stale/phantom rows that need a separate audited reconcile before any live order.

Two timing/structure facts that bite:

- `arx_master_bridge_pool` is a PURE projection — `recomputeMasterPool` sums the
  `user_slot_allocation` rows and never mutates them. Recompute runs only on EA
  heartbeat + a few mt5/admin endpoints (no background timer), so after a direct
  DB allocation change wait ~15s for the next heartbeat before re-reading the pool.
- A real-money live order needs **explicit user approval** and must route through
  the EXISTING 16-gate Phase B pipeline — never a v2 shortcut.

**Why:** the proof contract may be marked complete ONLY when real broker truth is
proven end-to-end (EA exists, backend receives real v2 events, OnTradeTransaction
arrives, live micro-test reconciles). Completing on dispatch or empty telemetry
would be a fabricated proof.

**How to apply:** verify the telemetry, pool-within-cap, and position-truth
prerequisites first. If any fails, STOP + report; do not proceed to a live order.
