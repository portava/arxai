---
name: Real-time forming-bar tip (Scanner chart)
description: How the live-tick forming candle tip is composed, displayed, and kept honest — display/telemetry only.
---

# Real-time forming-bar tip

A server composer synthesizes the still-forming (current-interval) candle tip
from live EA BID ticks so the Scanner chart's newest bar ticks in real time.
`formingBarComposer.ts` folds each accepted tick across all CHART_TIMEFRAMES;
`getFormingBar` returns ONLY the current-interval bar.

**Rule — tip is opt-in display-only.** `buildChartFeed`/`getChartCandles` gain
`includeFormingTip` (default FALSE). Only the chart display routes pass `true`;
every analysis/Ruby/chart-intelligence caller keeps the default, so the tip
NEVER enters scoring/truth. truthResult/chartTruthScore are computed on closed
bars BEFORE the tip is folded.

**Rule — tip only on `source === "mt5_broker"`.** BID basis matches the
mt5_broker closed-candle basis (no half-spread seam).

**Rule — merge vs append.** Compare tip.openMs to the newest closed bar's open:
`>` ⇒ append a new isForming bar; `===` ⇒ merge live extremes onto it (keep
closed OPEN, take tip CLOSE, max HIGH / min LOW); `<` ⇒ ignore (stale tip behind
the feed — never rewind/duplicate). The authoritative closed CANDLE arriving one
interval later naturally supersedes the tip, so there is no orphan duplicate.

**Rule — freshness is driven by TICK age, not the trailing gap.** A tip pins the
newest bar to the current interval, so `trailingIntervals` would falsely read
0/clean. When `formingTipPresent`, `buildFeedStatus` uses
`classifyFormingFreshness(formingTickAgeMs)`: clean ≤ FORMING_TIP_LIVE_MS (15s),
else stale-frozen ("Live tick stream silent — forming bar frozen."). Integrity
checks on the closed bars (invalid OHLC, missing/dup/ooo) still run FIRST and win
over the forming verdict.

**Rule — freeze, never fabricate.** The bar mutates only on a real tick. On
silence it stops changing; once the interval rolls over with no new tick,
`getFormingBar` returns null (the prior-interval bar is never carried forward as
a fake live bar). Nothing is ever persisted to broker_candles/market_candles.

**Why:** the EA streams ticks (~2s) into the quote store but they never folded
into the served tip, so the chart only advanced when a closed CANDLE landed one
interval later. This adds liveness for DISPLAY/telemetry ONLY — no arx_live_*
table, no 16-gate, no execution/safety change.

**Frontend:** ScannerChartPanel subscribes `GET /api/chart/tick-stream?symbol&timeframe`
(SSE), applies non-frozen `forming_bar` events via `series.update()` (NOT
setData) with an out-of-order guard (`newestBarSecRef`); the 15s poll is demoted
to reconciliation.

**Rule — IMMEDIATE SSE push, no coalescing (latency addendum).** Each accepted
tick is forwarded the instant ingest folds it: `formingBarBus.emit` is a
synchronous EventEmitter call at the end of `foldFormingTick`, so the SSE
`res.write` runs INLINE within the ingest call stack. There must be NO
coalescing / min-gap / interval-flush timer between ingest and the SSE write
(an earlier 250ms coalesce was removed) — the server path must not be the
bottleneck. Every `forming_bar` event carries `tickWallMs` (the ingest-accept
wall clock from `state.lastTickWallMs`); the client measures ingest→browser
latency = `Date.now() - tickWallMs`. The 15s `setInterval` is a keepalive
heartbeat only, NOT a tick-flush timer.

**Why extracted to `routes/chartTickStream.ts`:** the handler is DB-free (imports
only the in-memory composer + pure timeframe/freshness helpers), so the
immediate-push path is covered by a real HTTP-level acceptance test that mounts
the handler on a bare express server, folds a tick, and measures the real
loopback ingest→client latency (measured ~2ms here). chart.ts imports it and
mounts `router.get("/chart/tick-stream", handleChartTickStream)`.

Tests: `pnpm --filter @workspace/api-server run test:forming-bar` (composer
bucket/roll/freeze, freshness branch, buildChartFeed append/merge + analysis
exclusion) and `test:forming-tick-latency` (HTTP loopback latency + no-coalescing
+ tickWallMs propagation). Both wired into root `ci`.
