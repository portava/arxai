---
name: Scalp add-on revenge guard ordering
description: Why a losing basket can return DO_NOT_ADD without revengeGuardTriggered=true; and why modifier shifts must be gated on a live base tier
---

In `evaluateAddOn` (artifacts/api-server/src/lib/scalp/scalpManage.ts) the
revenge-trade guard (`revengeGuardTriggered`) only fires when the flame is
still ALIVE — i.e. `maxAddOns > 0`.

**Why:** the function checks `flame.blind` then `maxAddOns === 0` BEFORE the
`losing` branch. Fading/dead stages (WEAKENING, STRETCH, EXHAUSTED, FAILED,
REVERSAL_RISK) drive `baseAddOnTier` to 0, so a losing basket on a fading
flame returns `DO_NOT_ADD` via the `maxAddOns===0` branch and never reaches
the losing branch — `revengeGuardTriggered` stays false. The guard is for the
specific case "flame still burning, but you're underwater": alive tier +
`profitCushion < 0`, refused unless `isFreshConfirmation` (STRONG + healthy
stage + EARLY/CLEAN timing + chaseRisk != EXTREME), which permits ONE cautious
add.

**How to apply:** to test/exercise the revenge guard, keep the flame alive
(e.g. entryTiming "LATE" keeps tier at 1) AND set negative floatingPl. Don't
use a fading flameStage — that tests the dead-flame path, not the guard.

## Modifier shifts must be gated on a live base tier (forced-zero floor)

`baseAddOnTier` returns a PROTECTIVE forced-0 for dead/fading/extreme-chase/
no-runway/blind flames. Any additive modifier on top of it
(`personalityTierShift`: AGGRESSIVE/OWNER_ADMIN = +1) must be applied ONLY when
`baseTier > 0`. The original `clampTier(baseAddOnTier + shift)` let a +1
resurrect a forced-0 to tier 1 (`allowed=true`) — i.e. the modifier defeated
the very floor that exists to block revenge-adds on an exhausted/reversing burst.

**Why:** a forced-zero is a safety floor, not a baseline to add to. Adding a
"risk appetite" modifier to a floor inverts its meaning. Locked by
`scalp/__qa__/scalpAddonForcedZero.test.ts` (failing→green).

**How to apply:** any future tier/score floor that means "do not act" must be
short-circuited (`base > 0 ? base + modifier : 0`) BEFORE additive modifiers —
never `clamp(floor + modifier)`. This pattern (protective floor + appetite
modifier) recurs across scalp add-ons, scanner caps, and risk sizing.
