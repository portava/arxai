---
name: Deriv per-symbol feed verdict (one honest story)
description: A synthetic's live/tick/readiness must come from THAT symbol's own cached tick, never the global Deriv clock; plus the stale-server diagnostic trap.
---

# Per-symbol Deriv synthetic feed honesty

A synthetic symbol's `isLive` / `lastTickTime` / `feedReadinessState` (and the
live-entry "synthetic live-confirmed" floor) must ALL derive from THAT symbol's
own cached tick (`getCachedTickByDerivId(derivId)`), never the global Deriv
last-tick clock. A different volatility index ticking must not promote another
to LIVE_FEED.

**Why:** the global resolver reads a single `lastTickAt` that is fresh whenever
ANY subscribed synthetic ticks. Driving a per-symbol badge / live-entry gate off
that global clock is a false-positive: it shows V100 as "LIVE_FEED" while V100
has never ticked, just because V75 is live. The fix must stay ACCURATE — fix the
false-negative (a genuinely-ticking symbol reads live) without re-introducing
that false-positive (stale tick, or a sibling ticking, never reads THIS symbol
live).

**How to apply:** the single source is `getDerivSymbolFeedStatus(symbolOrLabel,
maxAgeMs)`; every chart/scanner/Ruby/live-floor surface consumes it. When adding
a new synthetic-feed surface, route it through that one call — never re-derive
liveness from the global `getDerivFeedStatus()`/`client.hasRecentTick()`.
Regression-guard it: seed only one symbol's tick AND set the global `lastTickAt`
fresh, then assert the OTHER symbol reads not-live.

## Stale-server diagnostic trap (cost me a false bug hunt)

A `/api/chart/feed-status` response that is INTERNALLY contradictory —
`feedReadinessState:"LIVE_FEED"` together with an "awaiting a confirmed live
tick" warning / `isLive:false` for the same symbol — cannot arise from the
current source (both fields derive from one `getDerivSymbolFeedStatus` call). It
means the api-server workflow is running STALE pre-edit code. Restart the
`API Server` workflow before trusting any provider/chart-feed QA; edits to
provider/chart modules are NOT hot-reloaded into the running process.

**Also:** repeated `tsc -p ... --noEmit` invocations that exit `-1`/no-output do
NOT die — they leave orphaned `tsc` processes that pile up and OOM every
subsequent run (and the shell, exit 137). `pkill -9 -f "tsc -p tsconfig"` and
let memory settle before retrying. (See typecheck-oom-this-env.md.)
