---
name: Owner-unrestricted live preflight relaxations
description: Which live-preflight gates the owner/admin unrestricted profile is allowed to skip, and the exact conditions — so future preflight edits stay owner-only and Deriv-scoped.
---

# Owner-unrestricted live preflight relaxations

Two app-added preflight relaxations exist for privileged users — but they are
gated DIFFERENTLY, on purpose:

1. The internal per-trade **margin proxy** ($1000/lot heuristic) is now a
   *governance toggle*, not an owner-only profile bypass. Guarded by
   `!useGovernance || gov.enforceAllocationLimit` where
   `useGovernance = gov.isPrivileged && gov.ownerLiveControlMode` (true for OWNER
   AND ADMIN with control mode ON). Default OFF → skipped; flip
   `enforceAllocationLimit` ON to re-enforce. The hard master-cap reconciliation
   guard and the real broker-side OrderSend margin check still run regardless.
2. The **Deriv-synthetic hard floor** stays **owner-only** (`isOwnerUnrestricted`)
   — no governance toggle represents it, because it touches broker-routing truth
   / the shared master pool. (Otherwise refuses every
   `assetClass==="synthetic" || dataProvider==="deriv"` symbol with
   `SYMBOL_NOT_LIVE_TRADABLE`). The owner bypass additionally requires BOTH:
   - the pinned master connection's `brokerName` matches `/deriv/i`
     (resolve via `resolveActiveMasterConnectionId()` then `mt5ConnectionTable`
     — this is the LIVE_SHARED execution-routing anchor, NOT the draft's label
     bridge, which can be a different/demo connection), AND
   - broker truth (`getBrokerSymbolSpec` → `arx_symbol_specs`) does not say
     `tradeAllowed===false / visible===false / tradeMode DISABLED|CLOSEONLY`.
     When no broker-truth row exists yet, the symbol is still allowed (Deriv
     genuinely offers synthetics; OrderSend validates honestly).

**Why:** the owner's tiny tickets (0.01 lot on a $7 allocation) were falsely
blocked — 0.01×$1000=$10 > $7 → `USER_ALLOCATION_EXHAUSTED` — and the blanket
synthetic floor was wrong for a Deriv master that actually offers Volatility
indices. Both were explicitly user-approved, owner/admin-only.

**The Deriv-synthetic floor exists in TWO places that must stay in lockstep:**
the preflight copy in `createLiveDraft` AND a defense-in-depth re-check at the
top of `dispatchLiveCommand` (the dispatch-stage floor, reason suffix
`_is_<provider>_data_only`). Relaxing only preflight moves the block from the
draft stage to the dispatch stage — the symptom looks like a *different* bug
(allocation block disappears, `SYMBOL_NOT_LIVE_TRADABLE:..._data_only` appears).
Apply the identical owner+Deriv-broker+broker-truth condition to both.

**How to apply:** when touching preflight gating, keep these two relaxations
gated on `isOwnerUnrestricted` (and the synthetic one also on Deriv-broker +
non-blocking broker truth). Never extend to normal users or non-Deriv brokers.
Every OTHER gate still runs for the owner: `userAvailable<=0`,
`isOverAllocated`, master-cap, snapshot freshness, kill switch, AND the entire
16-gate dispatch evaluator (unchanged — these are preflight-only relaxations;
dispatch still requires a real user Confirm). Real broker-side margin/symbol
validation at OrderSend remains the final authority.
