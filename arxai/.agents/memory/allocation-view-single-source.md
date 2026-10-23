---
name: Live allocation single-source-of-truth
description: Why display surfaces must read getUserAllocationView (the gate's source), never static virtual_balance, and the not-assigned vs exhausted split.
---

Live-allocation availability has ONE truth: `getUserAllocationView(userId)` in
`masterBridgePool.ts`. Available = `assignedAllocation − reservedRisk + openFloatingLoss`
(floating loss is negative, so open losers shrink headroom). `hasAllocation` = row
exists AND `assignedAllocation > 0`.

**Rule:** every display surface (Cockpit `CockpitCards.tsx`, `SharedAccountCard.tsx`)
must read `summary.allocationView.availableAllocation`, NOT the per-account static
`accounts[].virtualBalance`. The static balance drifts from the live gate, producing
the classic "Cockpit says $X available / all clear" while a live submit blocks
`USER_ALLOCATION_EXHAUSTED`. The summary endpoint exposes a top-level `allocationView`
(per-user scoped) so the card shows exactly what the gate enforces.

**Why:** the live gate/preflight already enforce on the view; if the card reads a
different number the user is told they have headroom they don't, then gets refused.

**Gate split (do NOT weaken — both still BLOCK):** the pure DB-free helper
`resolveAllocationGate` in `lib/live/allocationGate.ts` (called by `liveCommandPipeline.ts`)
distinguishes `LIVE_BLOCKED:USER_ALLOCATION_NOT_ASSIGNED` (`!hasAllocation`) from
`LIVE_BLOCKED:USER_ALLOCATION_EXHAUSTED` (assigned>0 but available≤0). `hasAllocation`
takes precedence even if `availableAllocation` is somehow >0. TRUE-zero / not-assigned
still refuse; the split only improves copy, never bypasses.

**How to apply:** a new live reason code needs lockstep copy entries in
`structuredRejection.ts`, `humanize.ts` (CATEGORY + REASON_MAP), `effectiveGovernance.ts`
CODE_META (BOTH raw and `LIVE_BLOCKED:` forms), and the `MASTER_POOL_PREGATE_CODES` list
in `livePoolGateCopy.test.ts`, or the parity test fails. Keep the gate logic in the pure
helper (offline-testable) and only the DB read (`getUserAllocationView`) in the pipeline.
