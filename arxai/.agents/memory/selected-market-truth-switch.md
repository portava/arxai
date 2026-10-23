---
name: Selected Market panel truth switch + CI guard lockstep
description: The Scanner Selected Market panel must analyze real candles (analyzeMarketFromCandles), not the simulator (analyzeMarket); and a CI guard that encodes an old contract must be updated when a task supersedes it.
---

# Selected Market panel: simulator → real candles

The Scanner "Selected Market" builder (`selectedMarket.ts`) must analyze REAL
broker candles via `getChartCandles()` + `analyzeMarketFromCandles()`, never the
simulator. Two variants of the brain's signal engine live in `aiBrain.ts`:
- `analyzeMarket(symbol, timeframe)` — SIMULATOR-backed (the "different price world").
- `analyzeMarketFromCandles(...)` — candle-injectable, pure; the honest path.

Freshness honesty: `dataAsOf` = the feed's newest-candle time (snaps to the
candle bucket, e.g. M15→:45, H1→:00), which is DISTINCT from `generatedAt`
(wall-clock build time). Stamp from DATA time, never build time. The no-data
path returns an honest `ok:true` WAITING envelope (bias WAIT, null levels,
dataState UNAVAILABLE) — never a fallback to simulator data.

Timeframe: coerce via `isChartTimeframe` (unknown→M15) BEFORE computing the
cache key, so a junk token can't poison a separate cache slot. Echo the
coerced timeframe back and include it in the react-query key + both fetch URLs.

# CI-guard-encodes-old-contract trap (durable process lesson)

**Rule:** When a task deliberately supersedes a contract that a CI guard
encodes, the guard must be updated in lockstep — or CI goes permanently red on
the very change you were asked to make.

**Why:** `check-scanner-selected-market.ts` REQUIRED `analyzeMarket()` (the
simulator) — exactly what #518 removed. The guard's *intent* ("reuse the brain,
no parallel signal engine") was still satisfied by `analyzeMarketFromCandles`,
so the fix was to retarget the guard, not weaken it: require
`analyzeMarketFromCandles(` + `getChartCandles` + `evaluateLevelStaleness` AND
forbid `\banalyzeMarket\(` and `marketSimulator`. That is a *tightening*.

**How to apply:** Before assuming a guard failure is your bug, read the guard.
If it asserts the pre-task behavior, updating it is in-scope (a guard is not the
"brain/route-auth/execution/gates" untouchable set). Regex note: `\banalyzeMarket\(`
does not false-match `analyzeMarketFromCandles(` — the `(` must immediately follow.
