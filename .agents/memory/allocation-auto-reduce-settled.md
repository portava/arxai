---
name: Automatic settled-only allocation reduction
description: Money-safe rules for auto-reducing shared-master pool allocations to fit a dropping real balance without ever touching open-trade users.
---

When the shared-master real backing (`min(balance, equity)` — Strict Real-Balance
Mode) drops below total `user_slot_allocation.allocated_funds`, the pool must
auto-reduce allocations to fit. Operator policy: **never pull from a user with an
OPEN live position; wait for the bridge to settle (positions close), then adjust.**

Durable rules (all live-verified):

- **Protect open-trade users absolutely.** Reduce only "settled" users
  (positive allocation AND no `arx_live_positions WHERE closed_at IS NULL`). If
  every dollar of the overage is held by open-trade users, leave the pool
  honestly over-allocated (the dispatch pre-gate keeps blocking) and wait — do
  NOT touch them. The open-trade user's allocation stays byte-stable across every
  heartbeat.
- **Only ever REDUCE, never auto-increase.** Auto-increase stays a manual admin op.
- **Reductions need a residual-cent pass.** Pure per-row `round2(prev*ratio)`
  drifts: it can leave the pool a few cents over cap, or in small-balance states
  round every row unchanged while reporting "REDUCED". Do proportional shares
  first, then distribute the leftover `reducible - sum(reductions)` largest-prev
  first (stable by id), never below 0. Keep `reason`/`adjusted` in lockstep.
- **All allocation-capacity mutators must serialize on ONE advisory lock**
  (`pg_advisory_xact_lock(74220001,1)`). Different paths lock multiple
  `user_slot_allocation` rows in different orders (transfer = userId order,
  auto-reconcile = id order) → guaranteed deadlock class without a shared lock.
  Take it at the top of every mutating tx (add/set/transfer/reduce/
  reduce-proportional/auto-reconcile) before any row lock.
- **Cheap healthy-path skip on a hot path.** Auto-reconcile runs fire-and-forget
  after every EA heartbeat/sync (~15s). Read-only precheck the pool's
  `is_over_allocated` flag (recomputed immediately before the call) and return
  WITHIN_CAP without opening a tx/locks when not over. The locked check still
  re-verifies inside the tx for the over case (no money-safety TOCTOU — worst
  case a needed reduction defers one heartbeat).
- **SYSTEM-actor audit.** Each reduction writes a per-user
  `admin_action_audit_log` row with `admin_id = null`, `admin_role = 'SYSTEM'`,
  action `AUTO_ALLOCATION_REDUCED_SETTLED`, before/after + delta. Manual/ai split
  is preserved proportionally. Env kill-switch
  `ARX_AUTO_REDUCE_ALLOCATIONS_DISABLED="true"`.

**Why:** this is money-critical drift correction; reducing a user mid-trade or
leaving the pool over-backed both risk real funds. It never places/modifies/
closes a trade and never touches the 16 Phase B gates — pure allocation math.

**How to apply:** when changing any allocation mutator, keep the single advisory
lock; when changing proportional math anywhere, keep a residual pass + the
open-position protection set scoped by userId.
