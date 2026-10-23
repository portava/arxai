---
name: Shared read-verdict reason unification
description: When one read-side verdict feeds multiple display surfaces, unify the REASON copy on every branch, not just the branch with the original bug.
---

# Shared read-verdict reason unification

When a single shared read-side verdict (e.g. a data-sufficiency verdict consumed
by scanner + Ruby + chart) is introduced to kill a cross-surface contradiction:

- A downgrade-only cap must key on the verdict's display flag for **any** data
  source (`if (sufficiency && !sufficiency.canShowTradeSetup)`), NOT scoped to
  the single data source where the original bug surfaced (e.g. `LIVE_FEED` only).
- A branch that relabels a read with freshness/"delayed candle" copy must defer
  to the verdict when the verdict's status is higher-precedence
  (insufficient/blocked). i.e. `liveDelayedRead = liveDelayed && !sufficiencyBlocks`.

**Why:** the first cut scoped the sufficiency cap to `LIVE_FEED` only, so a
`LIVE_DELAYED`/`AWAITING` row with too few closed bars stayed non-actionable
(freshness floors already did that) but surfaced the *freshness* reason while
Ruby/chart surfaced the *insufficiency* reason — the surfaces no longer
contradicted on the LABEL but still contradicted on the WHY. The whole point of
a shared verdict is one reason for the same symbol/timeframe across surfaces.

**How to apply:** broadening the cap stays downgrade-only/safe because the
freshness floors above already withheld actionability on non-live rows, so the
label/confidence change is a no-op there and the step only unifies the reason
copy. Add a regression test for the non-primary source (delayed/awaiting + thin
bars) asserting the SHARED humanReason is the one shown. A read-side verdict may
only block/downgrade — never grant — so applying it more broadly can never
authorize anything.
