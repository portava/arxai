---
name: Fund Book waterfall cutoff net value source
description: Overlay-precedence rule for the crystallization waterfall cutoff value and the run-header persistence rule.
---

The profit waterfall resolves a pool's cutoff `currentNetValue` with a fixed
precedence: a POOL overlay row in `fund_book_high_water_marks` WINS over
`strategy_pool_nav.totalPoolValue`. The contributed baseline (first-run prior
HWM) ALWAYS comes from NAV, regardless of any overlay.

**Why:** eligible profit = cutoff − prior HWM. If the two inputs disagree on
their source, runs crystallize against the wrong number.

**How to apply:**
- Any test or run-write that depends on cutoff must drive whichever source
  actually wins (overlay if present, else NAV), and restore both afterward.
- Persist the run header's cutoff as the RESOLVED value verbatim — never derive
  it from `priorHWM + eligibleProfit`. On flat/loss runs (eligible=0) the
  derived form silently records the prior HWM instead of the real cutoff and
  breaks auditability.
