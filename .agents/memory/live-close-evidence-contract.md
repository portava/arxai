---
name: Live close-evidence contract (wired into advanceCycle)
description: Where the close-honesty rule is codified and how it is enforced in the live-test-cycle runtime.
---

# Live close-evidence contract

`artifacts/api-server/src/lib/live/closeConfirmation.ts` (`resolveLiveCloseConfirmation`)
is the canonical pure predicate for "is a live close genuinely done":
`closedAt` stamped AND command in a terminal CLOSED/FILLED status AND no error
reason (rejectionReason/errorCode/errorMessage) — **mt5Retcode is ignored**.

**Why:** the EA can return retcode 10009 (success) on a close that did nothing
(POSITION_NOT_FOUND / positionTicket 0). Retcode alone is never proof.

**How it is enforced (wired):** the CLOSE_DISPATCHED branch of `advanceCycle`
(`liveTestCycle.ts`) now looks up the position by `openBrokerTicket`, calls
`resolveLiveCloseConfirmation`, and branches three ways:
- confirmed → COMPLETED + realised-P/L computation (the only path that completes).
- `LIVE_FILLED` + `hasCloseErrorReason(rejectionReason)` → phantom →
  `CLOSE_FAILED_MANUAL_REQUIRED` + CRITICAL `LIVE_TEST_CYCLE_CLOSE_PHANTOM` audit.
  (Phantom is detected from the error reason **independent of `closedAt`**, since a
  real phantom usually never stamps `closedAt`.)
- `LIVE_FILLED` no-error no-`closedAt` → stays CLOSE_DISPATCHED (honest pending,
  sync-timing gap); a later poll completes it once `closedAt` lands.

The user-facing surface also gates: `meLive.ts` command-status returns
`closeConfirmed`/`closeConfirmationReason` (computed only for
`CLOSE_LIVE_POSITION`), and `ScannerChartPanel.tsx` only declares a close
"executed" when `closeConfirmed === true`, else keeps polling.

**brokerMessage is NOT an error signal** for the close verdict — it can carry
benign broker success text. Only `rejectionReason` (and `errorCode`/`errorMessage`)
drive `hasCloseErrorReason`; pass only `rejectionReason` from arx_live_commands
(that table has no errorCode/errorMessage columns).

**Coverage:** `scripts/src/liveTestCycleCloseGuardIntegrationTest.ts` (DB-backed,
runs in `test:ci-inprocess`) exercises confirmed / phantom / pending(closedAt-null)
/ pending(no-position-row) against the real `advanceCycle`. The pure-predicate test
is `scripts/src/liveCloseEvidenceTest.ts`.

**Still test-only truth:** `resolveLiveCloseConfirmation` is NOT yet enforced in
the general (non-test-cycle) live close path — only the OWNER live-test cycle and
the command-status surface consume it. Any manual/Ruby live close completion copy
should route through the same contract before claiming "closed".
