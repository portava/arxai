---
name: Live Test Cycle — never own a parallel dispatch path
description: OWNER-only single-shot live verification must reuse the standard pipeline, never inline gates.
---

OWNER single-shot live test action must reuse the existing
`createLiveDraft → confirmLiveCommand → dispatchLiveCommand` chain and
the matching `createLiveOpsDraft` for auto-close. It is an *action*
inside Live/Live Shared, not a new mode.

**Why:** the 16-gate evaluator, allocation freeze, master live bridge
pinning, idempotency belt and audit row only run in that chain. Any
inline shortcut silently strips a gate.

**How to apply:**
- Preview = `createLiveDraft` (runs preflight) + `cancelLiveCommand`
  if the draft was created. `LIVE_CONFIRMATION_REQUIRED → LIVE_CANCELLED`
  is an allowed transition; `SENT_TO_MT5_LIVE → cancelled` is NOT, so
  preview must never confirm+dispatch.
- Single-flight = partial unique index on `(user_id)` where status is
  non-terminal — the service guard is a courtesy; the DB index is the
  truth.
- Auto-close = fires exactly once on `OPEN_FILLED`; on failure lock to
  `CLOSE_FAILED_MANUAL_REQUIRED` and never retry — manual operator
  resolution only.
- P/L formula in the service is pinned to the pinned symbol's contract
  size (100_000 for EURUSD). If you ever unpin the symbol, replace the
  formula with a per-symbol contract-size lookup before unpinning.
- Latency stages must be sourced from the underlying
  `arx_live_commands` truth (`sentToMt5At`, `pickedByEaAt`, `filledAt`)
  + `arx_live_positions` (`lastSyncedAt`, `closedAt`), not invented.
