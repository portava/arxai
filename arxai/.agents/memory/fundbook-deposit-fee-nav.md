---
name: Fund Book deposit fee must not discount NAV
description: navEngine.issueUnits double-counts a passed feeAmount against pool value; issue contributions on net with feeAmount=0 and keep the fee as a ledger row only.
---

# Fund Book contribution fees must never flow into pool feesAccrued

When settling a deposit/contribution that issues UNITS via `navEngine.issueUnits`,
do NOT pass the speed/entry fee as `feeAmount`. Issue on the **net** amount with
`feeAmount: 0` and record the fee solely as a transparent `fund_book_fee_entries`
ledger row.

**Why:** `issueUnits` adds `netAmount` to `depositsAllocated` AND `feeAmount` to
`feesAccrued`, and `computePoolNetValue` subtracts `feesAccrued`. A deposit fee
skimmed from the incoming gross was never pool capital, so adding it to
`feesAccrued` discounts the official NAV by the fee — a double-count, because the
fee is also written as a ledger entry. This violates the core invariant "official
NAV is never discounted; fees are transparent ledger rows." NAV must stay at its
official value across the contribution (units issued at current NAV ⇒ NAV
unchanged).

**How to apply:** Contribution path → `issueUnits({ grossAmount: netAmount,
feeAmount: 0 })`, fee recorded separately with `feeBasisAmount = gross`. The
withdrawal/redeem path is already correct: it passes no `feeAmount` to
`redeemUnits` (fees come out of the gross proceeds as net payout, pool value
reduced only by redeemed gross). Lock in regressions with a test that asserts
`strategy_pool_nav.fees_accrued` is unchanged by a deposit settle (read it
before/after), not just that the fee ledger row exists.
