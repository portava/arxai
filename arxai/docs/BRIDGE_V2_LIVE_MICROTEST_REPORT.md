# Bridge v2 — Live Micro-Test Verification Report (Phase 15 / 19)

**Run date:** 2026-06-08 (UTC)
**Environment:** the live ARX environment (only env where the real EA bridge heartbeats)
**Outcome:** ⛔ **BLOCKED — no live trade was placed.** All safety posture preserved.

This task verifies Bridge v2 with **one real live-money micro-trade**, but only if every
pre-live gate passes. Per the spec and task contract, **if any gate fails the agent stops
and reports the exact blocker — it never fakes success and never places a trade.** Multiple
pre-live gates failed, so no order was drafted, queued, or dispatched.

---

## Decisive blocker (root cause)

**The live EA / MT5 terminal is OFFLINE — no fresh heartbeat.**

- `mt5_connection` id 446 (user 4, Deriv (SVG) LLC, server DerivSVG-Server, account ••••0041):
  `last_heartbeat` is frozen at `2026-06-08 05:30:34Z`. Across repeated reads the server
  clock advanced (heartbeat age 130s → 168s → 245s → 255s) while `last_heartbeat` never
  changed — i.e. **no new heartbeat is arriving**. The EA terminal is not currently
  connected/polling.
- **Phase B gate #7 (heartbeat age ≤ 15s) hard-fails** → `MASTER_BRIDGE_HEARTBEAT_STALE`.

The EA runs on the operator's own MT5 terminal/VPS; it cannot be started from inside this
environment. Bringing it back online is an **operator action**.

## Compounding hard blockers (independent of the heartbeat)

All trace to the live account being effectively unfunded:

1. **Master pool OVER-ALLOCATED** — `arx_master_bridge_pool` id 2 (master_connection_id 446):
   `mt5_balance = 2.44`, `mt5_equity = 2.44`, `total_allocated = 1006`,
   `allocation_deficit = 1003.56`, **`is_over_allocated = TRUE`**.
   → preflight pre-gate refuses entry orders with `LIVE_BLOCKED:POOL_OVER_ALLOCATED`.
2. **Insufficient live balance for any micro-lot** — master balance **$2.44**. The pipeline's
   conservative margin proxy ($1000/lot) alone needs ~$10 for a 0.01-lot order for a normal
   (non-owner-unrestricted) USER, and the real broker margin check at OrderSend would reject
   regardless. → `LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED`.
3. **Master snapshot will go STALE** on the next recompute (it is driven by the now-frozen
   heartbeat). The stored snapshot reads FRESH only because it was last recomputed at the
   final heartbeat instant (05:30:39).

## Data-integrity observation (not changed — reconciler stays dry-run)

`arx_live_positions` holds **14 open (closed_at IS NULL) rows** for user 4 (Volatility 25/75
synthetics, e.g. tickets 4080385xxxx, volumes 0.1–5, floating P/L −136.79…+879.54). These
**contradict broker truth**: the master account reports balance $2.44, equity $2.44,
used_margin 0 — i.e. the broker shows **no** open positions. These rows are stale/phantom and
need reconciliation. Per the task's non-negotiable posture the reconciler was left in
**dry-run** and these rows were **not** modified.

---

## Phase 15 pre-live gate report (true status from ground truth)

| # | Pre-live condition | Status | Evidence |
|---|---|---|---|
| 1 | EA Bridge v2 installed/visible | ✅ PASS | `capabilities.bridgeVersion="2"`, EA v1.50, eaName `ARX_AI_Universal_Agent`, protocol 2 |
| 2 | **Fresh heartbeat (≤15s)** | ❌ **FAIL** | `last_heartbeat` frozen 05:30:34, age 255s+ and growing — EA offline |
| 3 | Config applied | ⚠️ N/A | `remoteConfig=false` on this EA; eaInputs present at last beat |
| 4 | Command polling working | ⚠️ UNVERIFIABLE now | Historically OK (commands reached SENT/FILLED Jun 2–3); cannot verify offline |
| 5 | Fresh account snapshot | ❌ FAIL | `account_synced_at` tied to stale heartbeat; balance $2.44 |
| 6 | Fresh positions snapshot | ❌ FAIL | snapshot stale; 14 phantom rows contradict broker |
| 7 | Fresh orders snapshot | ❌ FAIL | stale (EA offline) |
| 8 | Healthy trade-event ingest | ⚠️ N/A | offline |
| 9 | Sequence + idempotency + admin trace | ✅ present | `commandIdempotency` capability true; `arx_live_commands` audit history intact |
| 10 | Contradiction-free connected status | ❌ FAIL | `status="connected"` but heartbeat 255s stale; positions vs balance contradiction |
| 11 | Live broker balance/equity/margin (no dummy) | ⚠️ real but INSUFFICIENT | $2.44 / $2.44 / margin 0 — real values, not dummy, but unusable |
| 12 | No paper/demo wording in live flow | ⚠️ N/A | live flow not reached |
| 13 | OWNER/admin permission + live exec authorization | ⚠️ PARTIAL | user 4 `master_live_status=APPROVED`, armed (`is_armed=t`); role=USER (OWNER-only Live Test Cycle unavailable) |
| 14 | Tradable test symbol + broker-derived min lot | ❌ UNVERIFIABLE | symbol-spec freshness needs EA enumeration; EA offline. EURUSD is in allowlist |
| 15 | Acceptable spread | ❌ UNVERIFIABLE | no fresh ticks (EA offline) |
| 16 | Market open | ❌ UNVERIFIABLE | no fresh broker truth (EA offline) |
| 17 | Kill switch reachable | ✅ PASS | `emergency_kill_switch=f`, not engaged, reachable |
| 18 | Verified close path | ⚠️ infra present | unverifiable live (EA offline) |
| 19 | Reconciler stays dry-run | ✅ PASS | unchanged; phantom rows left untouched |
| 20 | MT5 candle contribution only if real | ⚠️ N/A | no fresh candles arrived |
| — | Master pool not over-allocated | ❌ FAIL | `is_over_allocated=TRUE` (2.44 vs 1006) |

Supporting safety inputs that *would* have passed once the EA is back and funded:
`ARX_LIVE_BROKER_EXECUTION_ENABLED="true"` (gate #1, unchanged), `live_broker_execution_armed=t`
(DB arm flag), `master_bridge_live_enabled=t`, `shared_live_trading_enabled=t`,
`platform_mode=LIVE`, arming `is_armed=t`, kill switch clear, EA last beat had
`readOnlyMode=false / enableLiveExecution=true / terminalConnected=true / algoTradingAllowed=true`,
EA v1.50 ≥ 1.27.

---

## Phase 19 final report

- **Symbol / volume / tickets:** none — no order was drafted or dispatched.
- **Lifecycle events:** none.
- **Fill / close status:** N/A (test not fired).
- **Final P/L:** N/A.
- **Broker retcodes/comments:** N/A.
- **Exact blocker:** the live EA/MT5 bridge is offline (heartbeat frozen, `MASTER_BRIDGE_HEARTBEAT_STALE`),
  the live Deriv master account is effectively unfunded ($2.44), and the master pool is
  over-allocated (`POOL_OVER_ALLOCATED`).

## What the operator must do before this test can run

1. **Bring the EA / MT5 terminal back online** so it heartbeats fresh (≤15s) — confirm via
   Admin → Live Gates Diagnostic that gate #7 reads PASS.
2. **Fund the live Deriv account** with enough balance to margin the smallest broker-allowed
   lot and to clear the pool over-allocation (or reduce assigned allocations so the pool is
   not over-allocated).
3. **Reconcile the 14 stale/phantom `arx_live_positions` rows** against broker truth (the
   reconciler is dry-run by design — this is an operator-reviewed action).
4. Re-run this verification. With a fresh, funded, connected EA every other input is already
   in place, so the 16-gate evaluator should be able to consider PASS.

## Safety attestation

No safety posture was changed. No env var was reset (`ARX_LIVE_BROKER_EXECUTION_ENABLED`
remains `"true"`). The reconciler stayed dry-run. No live trade was placed. No phantom rows
were modified. This task ends at the decision point exactly as the spec requires.
