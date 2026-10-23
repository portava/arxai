---
name: No fabricated capital baselines
description: How ARX surfaces account/equity/risk numbers honestly instead of defaulting to a placeholder $10,000.
---

Rule: never default a displayed money figure (account balance, equity-curve
start, risk budget) to a hardcoded placeholder (the recurring offender is
`10000`). Anchor to a REAL source or degrade to an honest unknown.

**Why:** the legacy `trades` performance views, the "Available Risk" stat, a
daily-loss alert, and the AACI broker snapshot each silently fabricated a
$10,000 (or $10,245.50) account. The only user with legacy `trades` actually
had ~$1,005 of operator-assigned capital, so the equity curve showed a fake
$10k start. Fabricated capital also poisons downstream risk/alert math.

**How to apply:**
- Equity/account baseline = operator-assigned capital from
  `user_slot_allocation.allocatedFunds` (> 0). Only fall back to a clearly
  NAMED notional constant when real legacy closed trades actually exist (the
  curve needs an anchor); with neither real capital NOR trades, return 0 — do
  not invent an account size. (`resolveEquityBaseline` in performance.ts.)
- Derived dollar figures (e.g. per-trade risk %) → return `null` when the real
  base balance is unknown so the UI renders "—"; do not compute off a
  placeholder.
- Budget-based alerts (daily-loss) → when there is no real end-balance
  baseline, return `{fired:false}` rather than firing off fabricated capital.
- The brokerReadOnly connector DEFAULTS to a `demo` provider that returns
  `connected:true` + placeholder balances. Any consumer that treats it as the
  real account (e.g. AACI snapshot) must gate on
  `broker.connected && broker.provider !== "demo"`; otherwise record the
  account/bridge as honest-unknown (push to `unavailable`). The `/broker-readonly`
  page itself is fine — it shows demo data only after an explicit, labeled
  "Run demo snapshot" click.
- `GetPerformanceSummaryResponse.accountBalance` is schema-required non-null and
  is NOT displayed in analytics (Balance/Equity come from the real shared-account
  hook), so it is kept as `baseline + totalPnl` rather than forcing an OpenAPI
  change to nullable.
