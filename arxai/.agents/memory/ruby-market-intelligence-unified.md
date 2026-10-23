---
name: Ruby broad market intelligence unified on the shared chart truth layer
description: All four of Ruby's broad market surfaces read one resolver; scanner enriches, never gates; opportunities use the single scoring path; news provider-gated
---

Ruby's four broad market-intelligence surfaces — the opportunities tool, the
per-symbol chat snapshot, the symbol/market-context builder, and the briefing's
selected-symbol read — all derive from ONE shared truth layer in
`lib/data/marketOverview.ts`, which is built OVER the same chart resolver the
chart UI uses (`getChartCandles` → `marketDataRouter.routeCandles` → feed
status). So what Ruby says about a symbol's source / quality / freshness matches
exactly what the chart shows for that symbol at the same moment.

**Why:** previously these surfaces read from different sources (a standalone
composite market provider and the frontend-driven live scanner) that could
disagree with the chart on the same symbol, and "unavailable" was sometimes a
guessed reason. Unifying on the chart resolver makes every honesty claim
self-consistent and every cause real (from feed status).

**How to apply / invariants to preserve:**
- **Enrich, never gate.** The per-symbol market picture must NEVER be blanked
  because the scanner/provider has no live feed. Only the `setups` section
  degrades, with an honest idle note. Don't reintroduce a code path where an
  idle scanner empties the whole overview.
- **Single scoring path.** Opportunities (Ruby's tool AND the per-user
  opportunity radar) route through `scanCoreOpportunities`, which loops
  `scanSymbolTimeframe` (the one scorer) and keeps ONLY `dataStatus === "live"`
  rows. Never hand-adapt provider candles into a second scorer, and never let a
  simulator / awaiting-feed / history-only row through as a setup.
- **feedConfirmed / feedCaveat.** `getMarketSnapshot` exposes
  `feedConfirmed = aiUsable && freshness === "REALTIME"` and a non-null
  `feedCaveat` (FEED_NOT_CONFIRMED_CAVEAT) whenever not confirmed; keep these in
  lockstep with the resolved snapshot.
- **News is provider-gated.** News/economic-calendar items are surfaced ONLY
  when the provider's `connected` flag is true — honest-empty otherwise. Any
  provider quote (bid/ask/spread) is optional enrichment, not the source of
  truth.
- **Hot-path latency.** The overview keeps a deliberately small core symbol set
  (`CORE_OVERVIEW_SYMBOLS`, 5) and a ~10s TTL cache because it runs in the chat
  hot path. Keep it small.
- **Advisory only.** None of this touches the 16-gate live dispatch, the live
  command path, or any safety contract.

**Measured latency (radar repoint, task step 2):** `evaluateOpportunitiesForUser`
on a realistic ~16-symbol watchlist is ~1s; a 50-symbol stress set is ~4–10s.
The cost is dominated by EXTERNAL provider rate-limiting (429s from
TwelveData/Finnhub) for symbols WITHOUT a live broker feed, not radar logic —
on-demand `scanSymbolTimeframe` fans out at concurrency 6. The radar is NOT on
the chat hot path (that path uses `getMarketOverview`: 5 core symbols + 10s
cache), so this is acceptable. If many-symbol radar latency ever matters,
the lever is feed coverage / concurrency, not a second cache.

**Tests:** `test:ruby-market-intelligence` (broker-source via the broker seam,
scanner-idle keeps the per-symbol picture, provider-limited states the real
cause, snapshot-vs-chart parity, never-simulator) and
`test:ruby-feed-not-confirmed` (feedConfirmed/feedCaveat both states). Both are
wired into root `ci` — note pnpm exits 0 on a missing filtered script, so a CI
reference without the matching `scripts/package.json` entry runs nothing.
