---
name: Shared chart feed-status honesty
description: Where the "live vs delayed vs stale vs analysis-only" chart verdict lives and which candle endpoint carries it
---

Every chart surface that renders candles must show the SAME honest feed verdict
and never imply more-live than the feed is.

- The resolver + types are centralized in
  `artifacts/trading-dashboard/src/lib/chart-display-status.ts`
  (`resolveDisplayStatus`, `applyHeaderCap`, `isLivePriceDisplay`, `FeedStatus`,
  `ChartDisplayStatus`). The badge presentation is `components/charts/ChartFeedStatusBadge.tsx`
  (fixed copy per state; takes a `testIdPrefix`). Scanner, PositionMiniChart all
  import these — do NOT re-define the resolver locally.

**Why:** before this, only the Scanner was honest; position mini-charts drew a
live "Current" line on a stale feed, implying live data that wasn't.

**How to apply:** a NEW chart surface resolves `displayStatus` from the
`/api/chart/candles` feedStatus and (a) renders `<ChartFeedStatusBadge>`, (b)
gates every live-price affordance (last-value/price-line label, "current" line)
on `isLivePriceDisplay(status)`.

Two candle endpoints, NOT interchangeable:
- `/api/chart/candles` → `{ candles, feedStatus, … }` honest truth contract.
  Timeframes are MT5-style: `M1 M5 M15 M30 H1 H4 D1` (not `15m`).
- `/api/data/candles` → BARE candle array, no feedStatus (legacy, left
  unchanged). A chart that needs honesty must use `/api/chart/candles`.

ARXNativeChart keeps its PARALLEL badge/header system (`lib/feed-confidence.ts`
+ `FeedConfidenceBadge`) — don't replace the badge. BUT its live-price
affordances (the candlestick last-value/price-line label + the dashed "Last"
line) are gated through the SHARED `isLivePriceDisplay(resolveDisplayStatus(...))`,
not feed-confidence. The candlestick series must explicitly set
`priceLineVisible`/`lastValueVisible` to the live-gated var (lightweight-charts
defaults `lastValueVisible:true` → a non-live feed would otherwise show a live
last-price label). No `applyHeaderCap` on ARX: its header derives from the same
feedStatus so they can't disagree.

A source-scan guard (`lib/chart-live-affordance-guard.test.ts`) enumerates every
file that does `addSeries(CandlestickSeries…)` and FAILS unless it (a) imports
`isLivePriceDisplay`, (b) explicitly sets both visibility options, (c) binds them
to an `isLive*` var (never a literal). Add a new candlestick chart → it must obey
this or the build breaks.

TradingView embed is genuinely-live TradingView data but is a third-party
REFERENCE feed, not the ARX broker feed — its badge must say so, never bare
"LIVE MARKET CHART".

Badge copy is FIXED per state and never reuses `feedStatus.message/.warning`
(those can phrase a capped surface as "Live … (mt5_broker)" and leak a source
token).

Scanner header badge is now single-sourced through the shared
`ChartFeedStatusBadge` (`testIdPrefix="scanner-chart"`) — it used to carry a
byte-identical inline copy (a silent drift surface). The badge a user actually
sees on the Scanner is driven by `useScannerTruth → resolveScannerTruth(...)`'s
`displayStatus` (= `resolvedDisplayStatus`), which is EQUAL-OR-SAFER than the
bare `resolveDisplayStatus(feed)` — never more-live (header cap + min-candle/age
gating can downgrade LIVE→ANALYSIS_ONLY but never the reverse). To test
"rendered badge matches the API and is never more-live", render the REAL
`ChartFeedStatusBadge` off the REAL `resolveScannerTruth` and assert
`SAFETY_RANK[truth.displayStatus] >= SAFETY_RANK[resolveDisplayStatus(rawFeed)]`
(higher rank = safer) — see `components/scanner/ScannerChartFeedBadge.test.tsx`.
An authenticated screenshot is impossible (screenshot tool can't inject the
`arx_user_session` cookie); that test's optional live leg is env-gated
(`ARX_BADGE_LIVE_BASE` + `ARX_BADGE_LIVE_COOKIE`) and hits real
`/api/chart/candles`.
