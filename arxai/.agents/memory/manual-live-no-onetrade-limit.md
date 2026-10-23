---
name: Manual live path has no one-trade limiter
description: The automated Live Test Cycle (single-shot verification) vs uncapped owner/admin manual live testing — do not conflate.
---
There is NO global "max ONE live trade" limiter on the owner/admin MANUAL live path
(scanner modal, chart, Trade page, Ruby — all funnel through createLiveDraft →
confirmLiveCommand → dispatchLiveCommand).

The "Live Test Cycle" is a one-time AUTOMATED OPEN+CLOSE *verification* with
single-flight (one open cycle per user). It is a check, not a per-account budget — it
neither consumes nor caps manual testing.

The "First Live Test Mode" preset is a legit per-user cap of max 1 *open position at a
time* (+ 0.01 lot, EURUSD only, SL required) — NOT "one trade ever". Leave it functional.

**Why:** UI copy ("One trade." on the cycle panel) created a false "one trade spent"
impression. The cycle is verification-only; an owner-visible status card shows the
uncapped manual-trade count.

**How to apply:** Manual opens are labelled via payload `phaseTag` (stamped in
createLiveDraft only — not ops/close, not cycle drafts), so the placed count is
queryable straight from arx_live_commands. Any future "live trade limit" claim
must distinguish: per-open-position caps (real) vs a one-trade-ever cap (does not exist).
