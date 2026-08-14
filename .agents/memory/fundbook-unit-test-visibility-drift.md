---
name: fundbook unit-accounting test visibility drift
description: Why scripts test:fundbook (in full ci) fails — the test's own POOL_KEY/hidden-pool assertions are self-contradictory since an upstream "fix fund book tests" change.
---

`scripts/src/fundBookUnitAccountingTest.ts` is red in `full-ci` / `pnpm run ci`
with 4 failures (as of early July 2026):
`investor view HIDES CASH_RESERVE`, `hidden-pool value never leaks into
settledValue (got 1000)`, `investor B view HIDES CASH_RESERVE too`,
`still HIDES ... after redeem`.

Root cause: an upstream "fix fund book tests" commit changed the test's
`POOL_KEY` from `CASH_RESERVE` to `BALANCED` but KEPT the June-19 hidden-pool
assertions (`viewExposesHiddenPool` checks `poolKey === POOL_KEY`). The
endpoint (`meFundBook.ts`) correctly shows ONLY BALANCED (Task #610 filter is
intact), so the test now asserts that the one pool investors are SUPPOSED to
see is hidden — self-contradictory, fails deterministically, standalone too.

**Why:** the assertions and the pool key were updated independently; the
endpoint contract (Balanced-only visibility, settledValue over visible pools)
is correct and unchanged.

**How to apply:** if a `mark_task_complete` full-ci validation fails only on
`test:fundbook` with these 4 messages and your diff has zero fundbook refs,
it's this pre-existing drift — skip with reason, don't mutate pool tables.
Proper fix (deliberate, own task): reintroduce a genuinely hidden test pool
(e.g. CASH_RESERVE) for the hidden-pool assertions while keeping unit math on
DB truth (`investor_pool_holdings` + `strategy_pool_nav`), OR drop the
hidden-pool assertions if BALANCED stays the seeded pool. Note BALANCED has
tier-based buy-in pricing — NAV $1.00 assumptions may not hold.
